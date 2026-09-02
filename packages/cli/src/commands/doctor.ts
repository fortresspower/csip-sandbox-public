import { resolve as resolvePath } from 'node:path';
import { flag, parseCommandArgs, requirePositionals, stringOption } from '../args.js';
import { daysUntil, loadCertificateIdentity, type CertificateIdentity } from '../certificate.js';
import type { Command, CommandContext } from '../command.js';
import {
  createDoctorTransport,
  probeAuthorization,
  runGraphChecks,
  type AuthorizationProbe,
} from '../doctor/graph.js';
import { checkOrigin, redactOrigin } from '../doctor/origin.js';
import { runTransportChecks } from '../doctor/transport-checks.js';
import {
  EXIT_CHECKS_FAILED,
  EXIT_OK,
  OperationalError,
  UsageError,
  type ExitCode,
} from '../errors.js';
import { EXIT_CODE_HELP, REPORT_HELP } from '../help.js';
import { ReportBuilder, serializeReport } from '../report/report.js';
import { renderReport } from '../report/render.js';
import type { TargetMode } from '../report/types.js';

/** The public DeviceCapability path. Fortress does not probe a list of candidate paths. */
export const DEFAULT_DEVICE_CAPABILITY_PATH = '/sep2/capability';

const USAGE = 'doctor <origin> [options]';

/**
 * Read-only readiness check.
 *
 * Answers one question: can a Fortress-shaped client safely connect to this origin and
 * discover the graph it needs? It does not prove control or telemetry behaviour — that is
 * `conformance` — and it never mutates anything, so it is safe to run against a live server.
 */
export function doctorCommand(): Command {
  return {
    name: 'doctor',
    arguments: '<origin> [options]',
    summary: 'Run read-only readiness checks against your server',
    help: () =>
      [
        `fortress-csip ${USAGE}`,
        '',
        'Check whether a Fortress-shaped client can connect to your IEEE 2030.5 server',
        'and discover the resources it needs. Every request is a GET: doctor never',
        'registers a device, posts telemetry, creates an assignment, or consumes a',
        'control, so it is safe against a live server.',
        '',
        'Options:',
        '  --cert PATH            Client certificate to authenticate with',
        '  --key PATH             Private key for that certificate',
        '  --ca PATH              Extra trust root (requires --local)',
        '  --local                Loopback rehearsal: permits --ca and a non-443 port',
        `  --path PATH            DeviceCapability path (default ${DEFAULT_DEVICE_CAPABILITY_PATH})`,
        '',
        ...REPORT_HELP,
        '',
        'Without --cert/--key, doctor runs the anonymous checks only: it confirms your',
        'server refuses a client that presents no identity. Anonymous success is a',
        'failure, because it means mutual TLS is not enforced.',
        '',
        'Examples:',
        '  fortress-csip doctor https://csip.partner.example',
        '  fortress-csip doctor https://csip.partner.example --cert client.pem --key client.key',
        '  fortress-csip doctor https://localhost:7443 --local --ca root.pem \\',
        '      --cert client.pem --key client.key',
        '',
        ...EXIT_CODE_HELP,
      ].join('\n'),
    run: async (argv: string[], context: CommandContext): Promise<ExitCode> => {
      const { values, positionals } = parseCommandArgs('doctor', argv, {
        cert: { type: 'string' },
        key: { type: 'string' },
        ca: { type: 'string' },
        local: { type: 'boolean' },
        path: { type: 'string' },
        json: { type: 'boolean' },
        out: { type: 'string' },
      });
      const [origin] = requirePositionals(positionals, 1, 'doctor', USAGE);

      const mode: TargetMode = flag(values, 'local') ? 'local' : 'deployed';
      const certPath = stringOption(values, 'cert', 'doctor');
      const keyPath = stringOption(values, 'key', 'doctor');
      const caPath = stringOption(values, 'ca', 'doctor');
      const deviceCapabilityPath = stringOption(values, 'path', 'doctor') ?? DEFAULT_DEVICE_CAPABILITY_PATH;
      const asJson = flag(values, 'json');
      const outPath = stringOption(values, 'out', 'doctor');

      // A custom trust root is the one input that can turn a real check into a self-fulfilling
      // one, so it is admissible only in the mode that is also pinned to loopback.
      if (caPath !== undefined && mode !== 'local') {
        throw new UsageError(
          '--ca is permitted only with --local: a deployed connection uses the standard public trust store',
          'doctor',
        );
      }
      if ((certPath === undefined) !== (keyPath === undefined)) {
        throw new UsageError('--cert and --key must be given together', 'doctor');
      }

      const report = new ReportBuilder('doctor', {
        origin: redactOrigin(origin),
        deviceCapabilityPath,
        mode,
      });
      const absolute = (path: string) => resolvePath(context.io.cwd, path);

      const parsed = await checkOrigin(origin, mode, report, context.resolveHost);
      // A failed origin check is not merely informational: the rules it enforces say which
      // addresses a Fortress-shaped client may contact at all. Connecting anyway — to a
      // private address, or to a name that resolves off-box under --local — would be the
      // toolkit doing the thing it just told the partner not to do.
      if (parsed !== undefined && report.healthy) {
        const certificateAuthorities =
          caPath === undefined ? undefined : [await readOrFail(context, absolute(caPath))];

        // The address the origin checks approved, not a fresh lookup. Re-resolving here
        // would connect to whatever DNS says now, which is not what was validated.
        const address = parsed.addresses[0];
        if (address === undefined) {
          for (const id of ['transport.server-certificate', 'transport.hostname', 'mtls.required',
            'transport.no-redirect', 'transport.response-bounds']) {
            report.skip(id, 'the origin did not resolve to an address to connect to');
          }
          skipAuthenticatedChecks(report);
        } else {
          const probeUrl = new URL(deviceCapabilityPath, parsed.url.origin);
          await runTransportChecks(report, {
            url: probeUrl,
            address,
            hostname: parsed.hostname,
            mode,
            certificateAuthorities,
          });

          if (certPath === undefined || keyPath === undefined) {
            skipAuthenticatedChecks(report);
          } else {
            const identity = await runAuthenticatedChecks(context, report, {
              origin: parsed.url.origin,
              address,
              deviceCapabilityPath,
              mode,
              certPath: absolute(certPath),
              keyPath: absolute(keyPath),
              certificateAuthorities,
            });
            if (identity !== undefined) {
              report.setIdentity({
                aggregatorLfdi: identity.aggregatorLfdi,
                certificateFingerprintSha256: identity.fingerprintSha256,
                certificateNotAfter: identity.notAfter.toISOString(),
              });
            }
          }
        }
      } else {
        skipEverythingAfterOrigin(report);
      }

      const built = report.build(context.io.now());
      const serialized = serializeReport(built);

      if (asJson) {
        context.io.out(serialized.trimEnd());
      } else {
        renderReport(built, context.io);
      }
      if (outPath !== undefined) {
        await context.io.writeFileAtomic(absolute(outPath), serialized);
        if (!asJson) context.io.out(`Report written to ${outPath}`);
      }

      return built.summary.fail > 0 ? EXIT_CHECKS_FAILED : EXIT_OK;
    },
  };
}

interface AuthenticatedOptions {
  origin: string;
  address: string;
  deviceCapabilityPath: string;
  mode: TargetMode;
  certPath: string;
  keyPath: string;
  certificateAuthorities?: Uint8Array[];
}

async function runAuthenticatedChecks(
  context: CommandContext,
  report: ReportBuilder,
  options: AuthenticatedOptions,
): Promise<CertificateIdentity | undefined> {
  let identity: CertificateIdentity;
  let certificate: Uint8Array;
  let privateKey: Uint8Array;
  try {
    certificate = await context.io.readFile(options.certPath);
    identity = await loadCertificateIdentity(options.certPath, async () => certificate);
    report.pass('client-certificate.present', 'client certificate loaded');
  } catch (error) {
    report.fail(
      'client-certificate.present',
      `the client certificate could not be used: ${(error as Error).message}`,
      'Pass the certificate (public) file with --cert.',
    );
    for (const id of ['client-certificate.key-match', 'client-certificate.not-expired',
      'client-certificate.lfdi', 'client-certificate.authorized']) {
      report.skip(id, 'requires a readable client certificate');
    }
    skipGraphChecks(report);
    return undefined;
  }

  try {
    privateKey = await context.io.readFile(options.keyPath);
  } catch (error) {
    report.fail(
      'client-certificate.key-match',
      `the private key could not be read: ${(error as Error).message}`,
      'Pass the matching private key with --key.',
    );
    for (const id of ['client-certificate.not-expired', 'client-certificate.lfdi',
      'client-certificate.authorized']) {
      report.skip(id, 'requires a readable private key');
    }
    skipGraphChecks(report);
    return identity;
  }

  const remaining = daysUntil(identity.notAfter, context.io.now());
  if (remaining < 0) {
    report.fail(
      'client-certificate.not-expired',
      `the client certificate expired ${-remaining} day(s) ago`,
      'Obtain a current certificate before testing authorization.',
    );
  } else if (remaining <= 30) {
    report.warn(
      'client-certificate.not-expired',
      `the client certificate expires in ${remaining} day(s)`,
      'Stage a replacement identity and allowlist its LFDI before this one lapses.',
    );
  } else {
    report.pass('client-certificate.not-expired', `valid for another ${remaining} day(s)`);
  }

  report.pass('client-certificate.lfdi', `aggregator LFDI ${identity.aggregatorLfdi}`);

  // The key/certificate pairing is proven by the TLS stack accepting them together; building
  // the transport is what forces that, and a mismatch fails here rather than mid-handshake.
  let transport;
  try {
    transport = createDoctorTransport({
      origin: options.origin,
      address: options.address,
      deviceCapabilityPath: options.deviceCapabilityPath,
      mode: options.mode,
      certificate,
      privateKey,
      certificateAuthorities: options.certificateAuthorities,
    });
    report.pass('client-certificate.key-match', 'certificate and key were accepted together');
  } catch (error) {
    report.fail(
      'client-certificate.key-match',
      `the certificate and key were rejected: ${(error as Error).message}`,
      'Confirm --key is the private key for --cert.',
    );
    report.skip('client-certificate.authorized', 'requires a usable certificate and key');
    skipGraphChecks(report);
    return identity;
  }

  try {
    // One authenticated read answers the authorization question and feeds the graph checks,
    // so the server sees a single GET rather than one per concern.
    const probe = await probeAuthorization(transport, options.deviceCapabilityPath);
    if (probe.ok) {
      report.pass(
        'client-certificate.authorized',
        `the server accepted aggregator LFDI ${identity.aggregatorLfdi}`,
      );
    } else if (probe.reason === 'authorization') {
      report.fail(
        'client-certificate.authorized',
        'the certificate was verified, but its LFDI is not authorized',
        `Allowlist aggregator LFDI ${identity.aggregatorLfdi} before retrying.`,
      );
    } else if (probe.reason === 'authentication') {
      report.fail(
        'client-certificate.authorized',
        'the client certificate was not accepted during the TLS handshake',
        'Install this certificate’s issuing chain in your server’s client trust store, then ' +
          `allowlist aggregator LFDI ${identity.aggregatorLfdi}. Both are required.`,
      );
    } else if (probe.reason === 'redirect' || probe.reason === 'too-large') {
      // The identity itself was fine — the transport fault is reported below instead.
      report.pass(
        'client-certificate.authorized',
        `the server accepted aggregator LFDI ${identity.aggregatorLfdi}`,
      );
    } else {
      report.fail(
        'client-certificate.authorized',
        `authorization could not be determined: ${probe.detail}`,
        'Confirm the DeviceCapability path is served over the authenticated CSIP route.',
      );
    }

    // On a server that correctly refuses anonymous clients the earlier probe could not see
    // the response at all, so these two were left undetermined. The authenticated read is
    // the one a real Fortress client makes, and it settles them.
    settleTransportChecks(report, probe);

    await runGraphChecks(report, transport, options.deviceCapabilityPath, probe);
  } finally {
    transport.close?.();
  }
  return identity;
}

function skipAuthenticatedChecks(report: ReportBuilder): void {
  for (const id of ['client-certificate.present', 'client-certificate.key-match',
    'client-certificate.not-expired', 'client-certificate.lfdi', 'client-certificate.authorized']) {
    report.skip(id, 'no client identity was supplied (pass --cert and --key)');
  }
  skipGraphChecks(report);
}

function skipGraphChecks(report: ReportBuilder): void {
  for (const id of ['graph.device-capability', 'graph.namespace', 'graph.time-link',
    'graph.end-device-list-link', 'graph.mirror-usage-point-list-link',
    'graph.same-origin-links', 'graph.positive-rates', 'graph.bounded-pagination']) {
    if (!report.has(id)) report.skip(id, 'requires an authorized client identity');
  }
}

function skipEverythingAfterOrigin(report: ReportBuilder): void {
  for (const id of ['transport.server-certificate', 'transport.hostname', 'transport.no-redirect',
    'transport.response-bounds', 'mtls.required']) {
    report.skip(id, 'the origin is not usable');
  }
  skipAuthenticatedChecks(report);
}

async function readOrFail(context: CommandContext, path: string): Promise<Uint8Array> {
  try {
    return await context.io.readFile(path);
  } catch (error) {
    throw new OperationalError(
      `could not read ${path}: ${(error as Error).message}`,
      'Check the path and that the file is readable by this user.',
    );
  }
}


/**
 * Fill in the redirect and byte-bound checks from the authenticated read.
 *
 * `resolveSkipped` only touches checks the anonymous probe left undetermined, so a server that
 * permits anonymous access — where those checks were already decided — keeps its earlier,
 * stricter result.
 */
function settleTransportChecks(report: ReportBuilder, probe: AuthorizationProbe): void {
  if (!probe.ok && probe.reason === 'redirect') {
    report.resolveSkipped(
      'transport.no-redirect',
      'fail',
      'the authenticated DeviceCapability request answered with a redirect',
      'Fortress never follows redirects on CSIP routes. Serve the resource directly at its advertised path.',
    );
    return;
  }
  if (!probe.ok && probe.reason === 'too-large') {
    report.resolveSkipped(
      'transport.response-bounds',
      'fail',
      'the authenticated DeviceCapability response exceeded the client byte limit',
      'Keep individual CSIP responses within the 1 MiB client limit; paginate lists with `l`.',
    );
    report.resolveSkipped('transport.no-redirect', 'pass', 'no redirect on the DeviceCapability path');
    return;
  }
  if (probe.ok) {
    report.resolveSkipped('transport.no-redirect', 'pass', 'no redirect on the DeviceCapability path');
    report.resolveSkipped(
      'transport.response-bounds',
      'pass',
      `response was ${probe.bodyBytes} bytes, within limits`,
    );
  }
}
