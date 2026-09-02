import { createServer, type Server } from 'node:https';
// Imported by composition seam rather than through the package barrel: the barrel starts a
// listening server as an import side effect, which a CLI must never do.
import { makeProductionPartnerApp } from '@fortress-csip/example-server/production';
import { MemoryPartnerPersistence } from '@fortress-csip/example-server/persistence/memory';
import { directMtlsConnectionResolver } from '@fortress-csip/example-server/direct-mtls-auth';
import { aggregatorLfdiFromCertificate, createCsipTransport } from '@fortress-csip/client-core';
import type { CommandContext } from '../command.js';
import { describeError, EXIT_CHECKS_FAILED, EXIT_OK, type ExitCode } from '../errors.js';
import { ReportBuilder, serializeReport } from '../report/report.js';
import { renderReport } from '../report/render.js';
import { onTermination } from '../signals.js';
import { createDisposablePki, type DisposablePki, type IssuedCertificate } from './test-pki.js';

/**
 * A disposable, production-shaped mutual-TLS rehearsal on loopback.
 *
 * The point is to let a partner see the exact authorization decision Fortress will meet, on
 * their own machine, before any certificate exchange has happened. It runs the production
 * partner app — not the open `/test/*` demo server — behind a Node TLS terminator with
 * `requestCert` and `rejectUnauthorized`, and resolves identity from the verified peer
 * certificate rather than from any caller-supplied header.
 *
 * Four cases, because the interesting property is not that the right client succeeds but that
 * the three wrong ones fail, and for the right reasons:
 *
 *   - a trusted, allowlisted client succeeds;
 *   - no client certificate fails;
 *   - a client from an untrusted issuer fails;
 *   - a trusted client whose LFDI is not allowlisted fails.
 *
 * The last is the one partners most often get wrong: trusting the issuer feels like it should
 * be enough, and it is not.
 */

export const MTLS_CHECK_IDS = [
  'mtls.authorized-allowlisted',
  'mtls.missing-client-certificate',
  'mtls.untrusted-client-issuer',
  'mtls.trusted-but-not-allowlisted',
] as const;

const CONNECTION_ID = 'rehearsal-connection';
const CAPABILITY_PATH = '/sep2/capability';

export interface RehearsalOptions {
  json?: boolean;
  out?: string;
  /** Resolve the output path against the working directory. Supplied by the command. */
  resolvePath?: (path: string) => string;
}

export async function runMtlsRehearsal(
  context: CommandContext,
  options: RehearsalOptions = {},
): Promise<ExitCode> {
  const report = new ReportBuilder('mtls-rehearsal', {
    origin: 'https://localhost',
    deviceCapabilityPath: CAPABILITY_PATH,
    mode: 'local',
  });

  let pki: DisposablePki | undefined;
  let server: Server | undefined;

  // Key material must not survive this command by any exit path, Ctrl-C included.
  const teardown = async (): Promise<void> => {
    await closeServer(server);
    await pki?.cleanup();
  };
  const release = onTermination(async () => {
    context.io.err('');
    context.io.err('Interrupted — removing the rehearsal key material.');
    await teardown();
  });

  try {
    // Progress goes to stderr, not stdout: with --json, stdout carries the report and
    // nothing else, so `fortress-csip demo --mtls --json | jq` works.
    context.io.err('Generating a disposable certificate authority...');
    pki = await createDisposablePki();

    const serverCertificate = await pki.root.issue('server', 'server');
    const authorizedClient = await pki.root.issue('authorized-client', 'client');
    const unallowlistedClient = await pki.root.issue('unallowlisted-client', 'client');
    const foreignClient = await pki.foreignRoot.issue('foreign-client', 'client');

    const authorizedLfdi = aggregatorLfdiFromCertificate(authorizedClient.certificate);
    const unallowlistedLfdi = aggregatorLfdiFromCertificate(unallowlistedClient.certificate);

    // The production app, with memory persistence and identity taken from the TLS peer.
    const persistence = new MemoryPartnerPersistence();
    const now = context.io.now().getTime();
    await persistence.createConnectionWithIdentity(
      {
        connectionId: CONNECTION_ID,
        recordType: 'connection',
        id: CONNECTION_ID,
        aggregatorLfdi: authorizedLfdi,
        createdAt: now,
        updatedAt: now,
      },
      {
        connectionId: CONNECTION_ID,
        recordType: 'connection-identity',
        id: authorizedLfdi,
        aggregatorLfdi: authorizedLfdi,
        createdAt: now,
        updatedAt: now,
      },
    );
    const { app } = makeProductionPartnerApp({
      persistence,
      resolveConnection: directMtlsConnectionResolver(persistence),
    });

    server = createServer(
      {
        cert: Buffer.from(serverCertificate.certificate),
        key: Buffer.from(serverCertificate.privateKey),
        // Both are required: requestCert alone asks for a certificate and accepts whatever
        // arrives, which is the misconfiguration this rehearsal exists to make visible.
        requestCert: true,
        rejectUnauthorized: true,
        ca: [Buffer.from(pki.root.certificate)],
      },
      app,
    );
    const port = await listen(server);
    const origin = `https://localhost:${port}`;
    context.io.err(`Rehearsal server listening on ${origin}`);
    context.io.err('');

    await checkAuthorized(report, origin, pki, authorizedClient, authorizedLfdi);
    await checkMissingCertificate(report, origin, pki);
    await checkUntrustedIssuer(report, origin, pki, foreignClient);
    await checkNotAllowlisted(report, origin, pki, unallowlistedClient, unallowlistedLfdi);
  } catch (error) {
    // An environment failure — no openssl, a port that will not bind — is not a check result,
    // but it must still be visible in the report rather than vanishing behind a stack trace.
    for (const id of MTLS_CHECK_IDS) {
      if (!report.has(id)) {
        report.fail(
          id,
          `the rehearsal could not run: ${describeError(error, 200)}`,
          'Resolve the local environment failure above and re-run.',
        );
      }
    }
  } finally {
    release();
    await teardown();
  }

  const built = report.build(context.io.now());
  if (options.json === true) {
    context.io.out(serializeReport(built).trimEnd());
  } else {
    renderReport(built, context.io);
    context.io.out('');
    context.io.out('All generated key material has been removed.');
  }
  if (options.out !== undefined) {
    const target = options.resolvePath?.(options.out) ?? options.out;
    await context.io.writeFileAtomic(target, serializeReport(built));
    if (options.json !== true) context.io.out(`Report written to ${options.out}`);
  }

  return built.summary.fail > 0 ? EXIT_CHECKS_FAILED : EXIT_OK;
}

async function checkAuthorized(
  report: ReportBuilder,
  origin: string,
  pki: DisposablePki,
  client: IssuedCertificate,
  lfdi: string,
): Promise<void> {
  const outcome = await attempt(origin, pki, client);
  if (outcome.ok) {
    report.pass(
      'mtls.authorized-allowlisted',
      `a trusted client whose LFDI ${lfdi} is allowlisted was served DeviceCapability`,
    );
    return;
  }
  report.fail(
    'mtls.authorized-allowlisted',
    `the allowlisted identity was refused: ${outcome.detail}`,
    'A trusted, allowlisted client must be served. Check that the connection record stores the exact aggregator LFDI.',
  );
}

async function checkMissingCertificate(
  report: ReportBuilder,
  origin: string,
  pki: DisposablePki,
): Promise<void> {
  // No client identity at all. client-core refuses to build such a transport by design, so
  // this one case goes through a bare TLS request.
  const outcome = await attemptAnonymous(origin, pki);
  if (!outcome.ok) {
    report.pass('mtls.missing-client-certificate', `a client presenting no certificate was refused (${outcome.detail})`);
    return;
  }
  report.fail(
    'mtls.missing-client-certificate',
    'a client presenting no certificate was served',
    'Set requestCert and rejectUnauthorized on the TLS listener. requestCert alone accepts whatever arrives.',
  );
}

async function checkUntrustedIssuer(
  report: ReportBuilder,
  origin: string,
  pki: DisposablePki,
  client: IssuedCertificate,
): Promise<void> {
  const outcome = await attempt(origin, pki, client);
  if (!outcome.ok) {
    report.pass('mtls.untrusted-client-issuer', `a client from an untrusted issuer was refused (${outcome.detail})`);
    return;
  }
  report.fail(
    'mtls.untrusted-client-issuer',
    'a client certificate from an unrelated issuer was accepted',
    'Restrict the client trust store to the Fortress client issuer. Trusting a broad root accepts identities Fortress did not issue.',
  );
}

async function checkNotAllowlisted(
  report: ReportBuilder,
  origin: string,
  pki: DisposablePki,
  client: IssuedCertificate,
  lfdi: string,
): Promise<void> {
  const outcome = await attempt(origin, pki, client);
  if (!outcome.ok) {
    report.pass(
      'mtls.trusted-but-not-allowlisted',
      `a trusted client whose LFDI ${lfdi} is not allowlisted was refused (${outcome.detail})`,
    );
    return;
  }
  report.fail(
    'mtls.trusted-but-not-allowlisted',
    'a trusted client whose LFDI is not allowlisted was served',
    'Trusting the issuer is not authorization. Check the presented certificate’s aggregator LFDI against your allowlist as well.',
  );
}

type AttemptOutcome = { ok: true } | { ok: false; detail: string };

/** One authenticated GET through the real client-core transport. */
async function attempt(
  origin: string,
  pki: DisposablePki,
  client: IssuedCertificate,
): Promise<AttemptOutcome> {
  const transport = createCsipTransport({
    baseUrl: origin,
    environment: 'local-test',
    resolveDns: async () => ['127.0.0.1'],
    tls: {
      certificate: client.certificate,
      privateKey: client.privateKey,
      certificateAuthorities: [pki.root.certificate],
    },
  });
  try {
    await transport.get(CAPABILITY_PATH);
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: describeError(error, 160) };
  } finally {
    transport.close?.();
  }
}

/** One GET with no client identity, which client-core deliberately cannot express. */
async function attemptAnonymous(origin: string, pki: DisposablePki): Promise<AttemptOutcome> {
  const { probeAnonymously } = await import('../doctor/probe.js');
  const outcome = await probeAnonymously({
    url: new URL(CAPABILITY_PATH, origin),
    address: '127.0.0.1',
    certificateAuthorities: [pki.root.certificate],
  });
  if (outcome.kind === 'response' && outcome.status >= 200 && outcome.status < 300) {
    return { ok: true };
  }
  const detail =
    outcome.kind === 'response'
      ? `HTTP ${outcome.status}`
      : outcome.kind === 'timeout'
        ? 'the handshake timed out'
        : outcome.kind === 'tls-rejected'
          ? 'rejected during the TLS handshake'
          : `connection failed: ${outcome.code}`;
  return { ok: false, detail };
}

function listen(server: Server): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (server === undefined) return;
  await new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}
