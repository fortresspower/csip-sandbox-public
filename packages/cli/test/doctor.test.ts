import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { aggregatorLfdiFromCertificate } from '@fortress-csip/client-core';
import { makeTestPki, type TestCertificate, type TestPki } from '../../client-core/test/test-certificates.js';
import { runCli } from '../src/cli.js';
import { createCommands } from '../src/commands/index.js';
import { EXIT_CHECKS_FAILED, EXIT_OK, EXIT_USAGE } from '../src/errors.js';
import { validateAgainstSchema } from '../src/report/validate.js';
import { ReportBuilder } from '../src/report/report.js';
import { checkOrigin } from '../src/doctor/origin.js';
import type { CheckStatus, Report } from '../src/report/types.js';
import { changingHostResolver, fixedHostResolver } from '../src/adapters/dns.js';
import { startCsipFixture, type FixtureOptions, type RunningFixture } from './support/csip-fixture.js';
import { REPOSITORY_ROOT, testContext } from './support/context.js';

let pki: TestPki;
let serverCertificate: TestCertificate;
let authorizedClient: TestCertificate;
let unallowlistedClient: TestCertificate;
let foreignClient: TestCertificate;
let schema: unknown;

const fixtures: RunningFixture[] = [];

beforeAll(async () => {
  pki = makeTestPki();
  serverCertificate = pki.root.issue('fixture-server', 'server', 'localhost');
  authorizedClient = pki.root.issue('authorized-client', 'client');
  unallowlistedClient = pki.root.issue('unallowlisted-client', 'client');
  foreignClient = pki.otherRoot.issue('foreign-client', 'client');
  schema = JSON.parse(
    await readFile(join(REPOSITORY_ROOT, 'schemas/fortress-csip-evidence-v1.schema.json'), 'utf8'),
  );
});

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

afterAll(() => pki.cleanup());

async function fixture(options: Partial<FixtureOptions> = {}): Promise<RunningFixture> {
  const running = await startCsipFixture({ server: serverCertificate, ...options });
  fixtures.push(running);
  return running;
}

/** Run doctor against a fixture, always in --local mode with the fixture's own root trusted. */
async function doctor(
  argv: string[],
  files: Record<string, Uint8Array> = {},
): Promise<{ code: number; out: string; err: string; report?: Report }> {
  const { context, io } = testContext({
    resolveHost: fixedHostResolver({ localhost: ['127.0.0.1'], '127.0.0.1': ['127.0.0.1'] }),
    io: {
      cwd: '/w',
      readFile: async (path: string) => {
        const contents = files[path];
        if (contents === undefined) {
          throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
        }
        return contents;
      },
    },
  });
  const code = await runCli(['doctor', ...argv], context, createCommands());
  const out = io.stdout.join('\n');
  let report: Report | undefined;
  if (argv.includes('--json')) report = JSON.parse(out) as Report;
  return { code, out, err: io.stderr.join('\n'), report };
}

const CLIENT_FILES = () => ({
  '/w/root.pem': pki.root.certificate,
  '/w/client.pem': authorizedClient.certificate,
  '/w/client.key': authorizedClient.privateKey,
  '/w/unallowlisted.pem': unallowlistedClient.certificate,
  '/w/unallowlisted.key': unallowlistedClient.privateKey,
  '/w/foreign.pem': foreignClient.certificate,
  '/w/foreign.key': foreignClient.privateKey,
});

function statusOf(report: Report, id: string): CheckStatus | undefined {
  return report.checks.find((check) => check.id === id)?.status;
}

const localArgs = (origin: string) => [origin, '--local', '--ca', '/w/root.pem'];
const authArgs = (origin: string, name = 'client') => [
  ...localArgs(origin),
  '--cert', `/w/${name}.pem`,
  '--key', `/w/${name}.key`,
];

describe('doctor is read-only', () => {
  it('issues only GET requests, and never a mutating one', async () => {
    const running = await fixture({
      clientTrustRoots: [pki.root.certificate],
      allowedLfdis: [lfdiOf(authorizedClient)],
    });
    await doctor([...authArgs(running.origin), '--json'], CLIENT_FILES());

    expect(running.requests.length).toBeGreaterThan(0);
    for (const request of running.requests) {
      expect(request.startsWith('GET ')).toBe(true);
    }
    // Named explicitly, so a future change that starts registering a device fails here.
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      expect(running.requests.some((request) => request.startsWith(method))).toBe(false);
    }
  });

  it('does not touch the EndDevice creation path', async () => {
    const running = await fixture({
      clientTrustRoots: [pki.root.certificate],
      allowedLfdis: [lfdiOf(authorizedClient)],
    });
    await doctor(authArgs(running.origin), CLIENT_FILES());
    expect(running.requests.every((request) => !request.includes('POST'))).toBe(true);
  });
});

describe('mutual TLS enforcement', () => {
  it('passes when an anonymous client is rejected at the TLS layer', async () => {
    const running = await fixture({ clientTrustRoots: [pki.root.certificate] });
    const { report } = await doctor([...localArgs(running.origin), '--json'], CLIENT_FILES());
    expect(statusOf(report!, 'mtls.required')).toBe('pass');
  });

  it('fails when an anonymous client receives a successful DeviceCapability', async () => {
    // No client trust roots: the server accepts anyone, which is the failure mode that
    // matters most and the one a partner is least likely to notice on their own.
    const running = await fixture();
    const { code, report } = await doctor([...localArgs(running.origin), '--json'], CLIENT_FILES());
    expect(statusOf(report!, 'mtls.required')).toBe('fail');
    expect(code).toBe(EXIT_CHECKS_FAILED);
    const check = report!.checks.find((entry) => entry.id === 'mtls.required');
    expect(check?.remediation).toContain('client certificate');
  });
});

describe('authenticated checks', () => {
  it('passes end to end for a trusted, allowlisted identity', async () => {
    const running = await fixture({
      clientTrustRoots: [pki.root.certificate],
      allowedLfdis: [lfdiOf(authorizedClient)],
    });
    const { code, report } = await doctor([...authArgs(running.origin), '--json'], CLIENT_FILES());
    expect(statusOf(report!, 'client-certificate.authorized')).toBe('pass');
    expect(statusOf(report!, 'graph.device-capability')).toBe('pass');
    expect(statusOf(report!, 'graph.namespace')).toBe('pass');
    expect(statusOf(report!, 'graph.time-link')).toBe('pass');
    expect(statusOf(report!, 'graph.end-device-list-link')).toBe('pass');
    expect(statusOf(report!, 'graph.mirror-usage-point-list-link')).toBe('pass');
    expect(statusOf(report!, 'graph.same-origin-links')).toBe('pass');
    expect(statusOf(report!, 'graph.positive-rates')).toBe('pass');
    expect(statusOf(report!, 'graph.bounded-pagination')).toBe('pass');
    expect(code).toBe(EXIT_OK);
  });

  it('reports the LFDI, fingerprint, and expiry of the identity used', async () => {
    const running = await fixture({
      clientTrustRoots: [pki.root.certificate],
      allowedLfdis: [lfdiOf(authorizedClient)],
    });
    const { report } = await doctor([...authArgs(running.origin), '--json'], CLIENT_FILES());
    expect(report!.identity?.aggregatorLfdi).toBe(lfdiOf(authorizedClient));
    expect(report!.identity?.certificateFingerprintSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(report!.identity!.certificateNotAfter)).not.toBeNaN();
  });

  it('distinguishes a trusted certificate whose LFDI is not allowlisted', async () => {
    const running = await fixture({
      clientTrustRoots: [pki.root.certificate],
      allowedLfdis: [lfdiOf(authorizedClient)],
    });
    const { code, report } = await doctor(
      [...authArgs(running.origin, 'unallowlisted'), '--json'],
      CLIENT_FILES(),
    );
    expect(statusOf(report!, 'client-certificate.authorized')).toBe('fail');
    const check = report!.checks.find((entry) => entry.id === 'client-certificate.authorized');
    expect(check?.summary).toContain('not authorized');
    expect(check?.remediation).toContain(lfdiOf(unallowlistedClient));
    expect(code).toBe(EXIT_CHECKS_FAILED);
  });

  it('reports a certificate from an untrusted issuer as a handshake rejection', async () => {
    const running = await fixture({
      clientTrustRoots: [pki.root.certificate],
      allowedLfdis: [lfdiOf(foreignClient)],
    });
    const { code, report } = await doctor(
      [...authArgs(running.origin, 'foreign'), '--json'],
      CLIENT_FILES(),
    );
    expect(statusOf(report!, 'client-certificate.authorized')).toBe('fail');
    expect(code).toBe(EXIT_CHECKS_FAILED);
  });

  it('skips authenticated checks rather than crashing when no identity is given', async () => {
    const running = await fixture({ clientTrustRoots: [pki.root.certificate] });
    const { report } = await doctor([...localArgs(running.origin), '--json'], CLIENT_FILES());
    for (const id of ['client-certificate.present', 'client-certificate.authorized',
      'graph.device-capability']) {
      expect(statusOf(report!, id)).toBe('skip');
    }
  });

  it('reports an unreadable client certificate as a failed check, not a crash', async () => {
    const running = await fixture({ clientTrustRoots: [pki.root.certificate] });
    const { report } = await doctor(
      [...localArgs(running.origin), '--cert', '/w/missing.pem', '--key', '/w/missing.key', '--json'],
      CLIENT_FILES(),
    );
    expect(statusOf(report!, 'client-certificate.present')).toBe('fail');
  });
});

describe('graph diagnosis', () => {
  const authorized = () => ({
    clientTrustRoots: [pki.root.certificate],
    allowedLfdis: [lfdiOf(authorizedClient)],
  });

  it('diagnoses a redirect', async () => {
    const running = await fixture({ ...authorized(), redirectTo: 'https://elsewhere.example/' });
    const { report } = await doctor([...authArgs(running.origin), '--json'], CLIENT_FILES());
    expect(statusOf(report!, 'transport.no-redirect')).toBe('fail');
  });

  it('diagnoses malformed XML', async () => {
    const running = await fixture({ ...authorized(), malformedCapability: true });
    const { report } = await doctor([...authArgs(running.origin), '--json'], CLIENT_FILES());
    expect(statusOf(report!, 'graph.device-capability')).toBe('fail');
  });

  it('diagnoses a missing namespace', async () => {
    const running = await fixture({ ...authorized(), omitNamespace: true });
    const { report } = await doctor([...authArgs(running.origin), '--json'], CLIENT_FILES());
    expect(statusOf(report!, 'graph.namespace')).toBe('fail');
  });

  it('diagnoses each missing required link by name', async () => {
    const running = await fixture({
      ...authorized(),
      omitLinks: ['Time', 'EndDeviceList', 'MirrorUsagePointList'],
    });
    const { report } = await doctor([...authArgs(running.origin), '--json'], CLIENT_FILES());
    expect(statusOf(report!, 'graph.time-link')).toBe('fail');
    expect(statusOf(report!, 'graph.end-device-list-link')).toBe('fail');
    expect(statusOf(report!, 'graph.mirror-usage-point-list-link')).toBe('fail');
  });

  it('diagnoses a cross-origin link without contacting the other origin', async () => {
    const running = await fixture({ ...authorized(), crossOriginLink: true });
    const { report } = await doctor([...authArgs(running.origin), '--json'], CLIENT_FILES());
    expect(statusOf(report!, 'graph.same-origin-links')).toBe('fail');
    const check = report!.checks.find((entry) => entry.id === 'graph.same-origin-links');
    expect(check?.summary).toContain('EndDeviceListLink');
  });

  it('diagnoses an invalid poll rate', async () => {
    const running = await fixture({ ...authorized(), invalidPollRate: true });
    const { report } = await doctor([...authArgs(running.origin), '--json'], CLIENT_FILES());
    expect(statusOf(report!, 'graph.positive-rates')).toBe('fail');
  });

  it('diagnoses inconsistent pagination metadata', async () => {
    const running = await fixture({ ...authorized(), brokenPagination: true });
    const { report } = await doctor([...authArgs(running.origin), '--json'], CLIENT_FILES());
    expect(statusOf(report!, 'graph.bounded-pagination')).toBe('fail');
  });

  it('diagnoses a page larger than the 500-item cap', async () => {
    const running = await fixture({ ...authorized(), oversizedPage: true });
    const { report } = await doctor([...authArgs(running.origin), '--json'], CLIENT_FILES());
    expect(statusOf(report!, 'graph.bounded-pagination')).toBe('fail');
  });

  it('diagnoses an oversized response on the authenticated path', async () => {
    const running = await fixture({ ...authorized(), oversizedBody: true });
    const { report } = await doctor([...authArgs(running.origin), '--json'], CLIENT_FILES());
    expect(statusOf(report!, 'transport.response-bounds')).toBe('fail');
  });

  it('diagnoses an oversized response on the anonymous path too', async () => {
    // No client trust: the anonymous probe reaches the body and decides the check itself.
    const running = await fixture({ oversizedBody: true });
    const { report } = await doctor([...localArgs(running.origin), '--json'], CLIENT_FILES());
    expect(statusOf(report!, 'transport.response-bounds')).toBe('fail');
  });

  it('settles redirect and byte-bound checks even when anonymous access is refused', async () => {
    // The common, correct case: the server enforces mutual TLS, so the anonymous probe sees
    // nothing. These checks must still be decided rather than silently skipped for everyone.
    const running = await fixture(authorized());
    const { report } = await doctor([...authArgs(running.origin), '--json'], CLIENT_FILES());
    expect(statusOf(report!, 'transport.no-redirect')).toBe('pass');
    expect(statusOf(report!, 'transport.response-bounds')).toBe('pass');
  });
});

describe('mode rules', () => {
  it('rejects --ca outside --local', async () => {
    const { code, err } = await doctor(
      ['https://csip.partner.example', '--ca', '/w/root.pem'],
      CLIENT_FILES(),
    );
    expect(code).toBe(EXIT_USAGE);
    expect(err).toContain('--ca is permitted only with --local');
  });

  it('rejects --local when the name resolves off loopback', async () => {
    const { context, io } = testContext({
      resolveHost: fixedHostResolver({ 'not-really-local.example': ['203.0.113.10'] }),
      io: { cwd: '/w' },
    });
    const code = await runCli(
      ['doctor', 'https://not-really-local.example:8443', '--local', '--json'],
      context,
      createCommands(),
    );
    const report = JSON.parse(io.stdout.join('\n')) as Report;
    expect(statusOf(report, 'origin.public-dns')).toBe('fail');
    expect(code).toBe(EXIT_CHECKS_FAILED);
  });

  it('requires TCP 443 in deployed mode', async () => {
    const { context, io } = testContext({
      resolveHost: fixedHostResolver({ 'csip.partner.example': ['198.51.100.10'] }),
    });
    await runCli(
      ['doctor', 'https://csip.partner.example:8443', '--json'],
      context,
      createCommands(),
    );
    const report = JSON.parse(io.stdout.join('\n')) as Report;
    expect(statusOf(report, 'origin.port-443')).toBe('fail');
  });

  it('rejects a deployed origin that resolves to a private address', async () => {
    const { context, io } = testContext({
      resolveHost: fixedHostResolver({ 'csip.partner.example': ['10.0.0.5'] }),
    });
    await runCli(['doctor', 'https://csip.partner.example', '--json'], context, createCommands());
    const report = JSON.parse(io.stdout.join('\n')) as Report;
    expect(statusOf(report, 'origin.public-dns')).toBe('fail');
  });

  it('rejects a deployed IP literal', async () => {
    const { context, io } = testContext({ resolveHost: fixedHostResolver({}) });
    await runCli(['doctor', 'https://198.51.100.10', '--json'], context, createCommands());
    const report = JSON.parse(io.stdout.join('\n')) as Report;
    expect(statusOf(report, 'origin.public-dns')).toBe('fail');
  });

  it('rejects a plain-HTTP deployed origin', async () => {
    const { context, io } = testContext({ resolveHost: fixedHostResolver({}) });
    await runCli(['doctor', 'http://csip.partner.example', '--json'], context, createCommands());
    const report = JSON.parse(io.stdout.join('\n')) as Report;
    expect(statusOf(report, 'origin.https')).toBe('fail');
  });

  it('rejects URL credentials in the origin', async () => {
    const { context, io } = testContext({ resolveHost: fixedHostResolver({}) });
    await runCli(
      ['doctor', 'https://user:secret@csip.partner.example', '--json'],
      context,
      createCommands(),
    );
    const report = JSON.parse(io.stdout.join('\n')) as Report;
    expect(statusOf(report, 'origin.valid')).toBe('fail');
    // The password must not survive into the report, which a partner may forward.
    expect(JSON.stringify(report)).not.toContain('secret');
  });

  it('resolves once and hands back the addresses it validated', async () => {
    // A validate-then-connect gap cannot be caught by a deterministic resolver, because both
    // lookups agree. This one changes its answer, so re-resolving is observable.
    const resolver = changingHostResolver([['93.184.216.34'], ['10.0.0.5']]);
    const calls: string[] = [];
    const counting = async (hostname: string) => {
      calls.push(hostname);
      return resolver(hostname);
    };
    const report = new ReportBuilder('doctor', {
      origin: 'https://csip.partner.example',
      deviceCapabilityPath: '/sep2/capability',
      mode: 'deployed',
    });
    const parsed = await checkOrigin('https://csip.partner.example', 'deployed', report, counting);

    expect(calls).toHaveLength(1);
    expect(parsed?.addresses).toEqual(['93.184.216.34']);
    // The private second answer must never appear in what the caller is told to connect to.
    expect(parsed?.addresses).not.toContain('10.0.0.5');
  });

  it('pins authenticated requests to the address validated by the origin checks', async () => {
    // End to end: the first answer is the loopback fixture and passes --local; the second is
    // off-box. The hostname deliberately has no system-DNS answer: both the anonymous probe and
    // authenticated transport must use the address that checkOrigin already approved.
    const hostname = 'pinned.partner.invalid';
    const running = await fixture({
      server: pki.root.issue('pinned-fixture-server', 'server', hostname),
      hostname,
      clientTrustRoots: [pki.root.certificate],
      allowedLfdis: [lfdiOf(authorizedClient)],
    });
    const { context, io } = testContext({
      resolveHost: changingHostResolver([['127.0.0.1'], ['203.0.113.99']]),
      io: { cwd: '/w', readFile: async (path: string) => CLIENT_FILES()[path as keyof ReturnType<typeof CLIENT_FILES>] },
    });
    await runCli(
      ['doctor', ...authArgs(running.origin), '--json'],
      context,
      createCommands(),
    );
    const report = JSON.parse(io.stdout.join('\n')) as Report;
    expect(statusOf(report, 'origin.public-dns')).toBe('pass');
    expect(statusOf(report, 'mtls.required')).toBe('pass');
    expect(statusOf(report, 'transport.server-certificate')).toBe('pass');
    expect(statusOf(report, 'client-certificate.authorized')).toBe('pass');
  });

  it('requires --cert and --key together', async () => {
    const { code, err } = await doctor(
      ['https://csip.partner.example', '--cert', '/w/client.pem'],
      CLIENT_FILES(),
    );
    expect(code).toBe(EXIT_USAGE);
    expect(err).toContain('must be given together');
  });
});

describe('report output', () => {
  const authorized = () => ({
    clientTrustRoots: [pki.root.certificate],
    allowedLfdis: [lfdiOf(authorizedClient)],
  });

  it('validates against the checked-in schema', async () => {
    const running = await fixture(authorized());
    const { report } = await doctor([...authArgs(running.origin), '--json'], CLIENT_FILES());
    expect(validateAgainstSchema(report, schema)).toEqual([]);
  });

  it('validates against the schema on a failing run too', async () => {
    const running = await fixture({ ...authorized(), malformedCapability: true });
    const { report } = await doctor([...authArgs(running.origin), '--json'], CLIENT_FILES());
    expect(validateAgainstSchema(report, schema)).toEqual([]);
  });

  it('carries no PEM body, private key, or raw XML', async () => {
    const running = await fixture({ ...authorized(), malformedCapability: true });
    const { report } = await doctor([...authArgs(running.origin), '--json'], CLIENT_FILES());
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('BEGIN CERTIFICATE');
    expect(serialized).not.toContain('PRIVATE KEY');
    expect(serialized).not.toContain('<DeviceCapability');
    expect(serialized).not.toContain('<?xml');
  });

  it('emits only JSON on stdout with --json', async () => {
    const running = await fixture(authorized());
    const { out } = await doctor([...authArgs(running.origin), '--json'], CLIENT_FILES());
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it('agrees between human and JSON output on the overall status', async () => {
    const running = await fixture({ ...authorized(), invalidPollRate: true });
    const human = await doctor(authArgs(running.origin), CLIENT_FILES());
    const json = await doctor([...authArgs(running.origin), '--json'], CLIENT_FILES());
    expect(human.code).toBe(json.code);
    expect(human.out).toContain('NOT READY');
    expect(json.report!.summary.status).toBe('fail');
  });

  it('shows remediation for failed checks in human output', async () => {
    const running = await fixture({ ...authorized(), omitLinks: ['Time'] });
    const { out } = await doctor(authArgs(running.origin), CLIENT_FILES());
    expect(out).toContain('FAIL');
    expect(out).toContain('Remediation:');
    expect(out).toContain('TimeLink');
  });

  it('writes the report atomically to --out', async () => {
    const running = await fixture(authorized());
    const { context, io } = testContext({
      resolveHost: fixedHostResolver({ localhost: ['127.0.0.1'] }),
      io: {
        cwd: '/w',
        readFile: async (path: string) => {
          const contents = CLIENT_FILES()[path as keyof ReturnType<typeof CLIENT_FILES>];
          if (contents === undefined) throw new Error(`ENOENT: ${path}`);
          return contents;
        },
      },
    });
    await runCli(
      ['doctor', ...authArgs(running.origin), '--out', 'evidence.json'],
      context,
      createCommands(),
    );
    const written = io.written.get('/w/evidence.json');
    expect(written).toBeDefined();
    expect(validateAgainstSchema(JSON.parse(written!), schema)).toEqual([]);
  });
});

function lfdiOf(certificate: TestCertificate): string {
  return aggregatorLfdiFromCertificate(certificate.certificate);
}
