import * as https from 'node:https';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { aggregatorLfdiFromCertificate } from '@fortress-csip/client-core';
import { makePartnerApp } from '@fortress-csip/example-server/partner-app';
import { MemoryPartnerPersistence } from '@fortress-csip/example-server/persistence/memory';
import { directMtlsConnectionResolver } from '@fortress-csip/example-server/direct-mtls-auth';
import { makeTestPki, type TestPki, type TestCertificate } from '../../client-core/test/test-certificates.js';
import { runCli } from '../src/cli.js';
import { createCommands } from '../src/commands/index.js';
import { fixedHostResolver } from '../src/adapters/dns.js';
import { EXIT_OK } from '../src/errors.js';
import { createMemoryIo } from '../src/io.js';
import { probeAnonymously } from '../src/doctor/probe.js';
import type { Report } from '../src/report/types.js';
import { testContext } from './support/context.js';

vi.mock('node:https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:https')>();
  return { ...actual, request: vi.fn(actual.request) };
});

const origin = 'https://fixture.invalid';
let pki: TestPki;
let client: TestCertificate;
let leaf: TestCertificate;
const servers: https.Server[] = [];

beforeAll(() => {
  pki = makeTestPki();
  client = pki.root.issue('cli-client', 'client');
  leaf = pki.root.issue('cli-server', 'server', 'fixture.invalid');
});
afterAll(() => pki.cleanup());
afterEach(async () => {
  vi.mocked(https.request).mockReset();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

async function fixture() {
  const persistence = new MemoryPartnerPersistence();
  const { app, domain } = makePartnerApp({ persistence,
    resolveConnection: directMtlsConnectionResolver(persistence) });
  await domain.createConnection('fixture', aggregatorLfdiFromCertificate(client.certificate));
  await domain.createProgram('fixture', 'rehearsal', 'rehearsal-dispatch', 3);
  const server = https.createServer({ cert: leaf.certificate, key: leaf.privateKey,
    ca: pki.root.certificate, requestCert: true, rejectUnauthorized: true }, app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture listener');
  const actual = await vi.importActual<typeof import('node:https')>('node:https');
  // Only the test's socket destination changes. Production validation still sees a public
  // DNS origin on 443; the real TLS stack verifies the original hostname and CA/client pair.
  vi.mocked(https.request).mockImplementation(((url: URL, options: https.RequestOptions, callback: Parameters<typeof https.request>[2]) => {
    expect(url.origin).toBe(origin);
    options.lookup!(url.hostname, { all: false }, (error, approved) => {
      expect(error).toBeNull();
      expect(approved).toBe('8.8.8.8');
    });
    const local = new URL(url);
    local.port = String(address.port);
    return actual.request(local, { ...options, lookup: (_hostname, lookupOptions, done) => {
      if (lookupOptions.all) done(null, [{ address: '127.0.0.1', family: 4 }]);
      else done(null, '127.0.0.1', 4);
    } }, callback);
  }) as typeof https.request);
}

async function run(command: 'doctor' | 'conformance', ca?: Uint8Array, extra: string[] = []) {
  const material: Record<string, Uint8Array> = {
    '/w/client.pem': client.certificate, '/w/client.key': client.privateKey,
    ...(ca === undefined ? {} : { '/w/root.pem': ca }),
  };
  const { context, io } = testContext({
    resolveHost: fixedHostResolver({ 'fixture.invalid': ['8.8.8.8'] }),
    io: createMemoryIo({ cwd: '/w', readFile: async (path) => {
      if (material[path] === undefined) throw new Error('file unavailable');
      return material[path];
    } }),
  });
  const code = await runCli([command, origin, '--cert', '/w/client.pem', '--key', '/w/client.key',
    ...(ca === undefined ? [] : ['--ca', '/w/root.pem']), '--json', ...extra], context, createCommands());
  return { code, out: io.stdout.join('\n'), err: io.stderr.join('\n') };
}

function status(report: Report, id: string) {
  return report.checks.find((check) => check.id === id)?.status;
}

describe('deployed CLI connection CA', () => {
  it.each(['doctor', 'conformance'] as const)('%s completes real mTLS with an explicit connection CA', async (command) => {
    await fixture();
    const result = await run(command, pki.root.certificate);
    expect(result.code, result.err).toBe(EXIT_OK);
    const report = JSON.parse(result.out) as Report;
    expect(report.target.mode).toBe('deployed');
    expect(status(report, command === 'doctor' ? 'client-certificate.authorized' : 'enrollment.first-registration')).toBe('pass');
    expect(status(report, command === 'doctor' ? 'graph.device-capability' : 'telemetry.standard-mup')).toBe('pass');
  });

  it.each(['doctor', 'conformance'] as const)('%s rejects an unrelated CA and keeps default trust unchanged', async (command) => {
    await fixture();
    for (const ca of [pki.otherRoot.certificate, undefined]) {
      const result = await run(command, ca);
      const report = JSON.parse(result.out) as Report;
      expect(status(report, command === 'doctor' ? 'client-certificate.authorized' : 'enrollment.first-registration')).toBe('fail');
      if (command === 'doctor') {
        expect(status(report, 'transport.server-certificate')).toBe('fail');
        expect(status(report, 'mtls.required')).toBe('skip');
        expect(report.checks.find((check) => check.id === 'transport.server-certificate')?.remediation).toContain('--ca');
      }
    }
  });

  it.each(['doctor', 'conformance'] as const)('%s rejects an empty explicit CA', async (command) => {
    const result = await run(command, new Uint8Array());
    expect(result.code).not.toBe(EXIT_OK);
    expect(result.err).toContain('non-empty');
    expect(https.request).not.toHaveBeenCalled();
  });

  it('keeps the anonymous CA probe on the configured origin', async () => {
    const result = await run('doctor', pki.root.certificate, ['--path', 'https://other.invalid/capability']);
    expect(result.err).toContain(`--path must use the expected origin ${origin}`);
    expect(https.request).not.toHaveBeenCalled();
  });

  it('rejects empty trust and non-HTTPS in the anonymous probe', async () => {
    for (const certificateAuthorities of [[], [new Uint8Array()]]) {
      await expect(probeAnonymously({ url: new URL(origin), address: '8.8.8.8', certificateAuthorities }))
        .rejects.toThrow('non-empty');
    }
    await expect(probeAnonymously({ url: new URL('http://fixture.invalid'), address: '8.8.8.8',
      certificateAuthorities: [pki.root.certificate] })).rejects.toThrow('requires HTTPS');
    expect(https.request).not.toHaveBeenCalled();
  });
});
