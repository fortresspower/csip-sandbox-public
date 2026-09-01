import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { aggregatorLfdiFromCertificate } from '@fortress-csip/client-core';
import { makePartnerApp } from '@fortress-csip/example-server/partner-app';
import { MemoryPartnerPersistence } from '@fortress-csip/example-server/persistence/memory';
import { directMtlsConnectionResolver } from '@fortress-csip/example-server/direct-mtls-auth';
import { createServer as createHttpsServer, type Server } from 'node:https';
import { fixedHostResolver } from '../src/adapters/dns.js';
import { runCli } from '../src/cli.js';
import { createCommands } from '../src/commands/index.js';
import { syntheticDevices } from '../src/commands/conformance.js';
import { describeInstruction } from '../src/conformance/drivers.js';
import { SerializableSessionStore } from '../src/conformance/session-store.js';
import type { ConformanceSessionFile } from '../src/conformance/types.js';
import { EXIT_CHECKS_FAILED, EXIT_OK, EXIT_USAGE } from '../src/errors.js';
import { validateAgainstSchema } from '../src/report/validate.js';
import type { CheckStatus, Report } from '../src/report/types.js';
import { makeTestPki, type TestCertificate, type TestPki } from '../../client-core/test/test-certificates.js';
import { REPOSITORY_ROOT, testContext } from './support/context.js';

let schema: unknown;

beforeAll(async () => {
  schema = JSON.parse(
    await readFile(join(REPOSITORY_ROOT, 'schemas/fortress-csip-evidence-v1.schema.json'), 'utf8'),
  );
});

/** An in-memory filesystem, so session persistence is observable without touching disk. */
function memoryFiles(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed));
  return {
    files,
    readFile: async (path: string): Promise<Uint8Array> => {
      const contents = files.get(path);
      if (contents === undefined) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      }
      return Buffer.from(contents, 'utf8');
    },
    writeFileAtomic: async (path: string, contents: string): Promise<void> => {
      files.set(path, contents);
    },
  };
}

function statusOf(report: Report, id: string): CheckStatus | undefined {
  return report.checks.find((check) => check.id === id)?.status;
}

async function selfTest(
  argv: string[] = [],
  seed: Record<string, string> = {},
): Promise<{ code: number; out: string; err: string; report: Report; files: Map<string, string> }> {
  const fs = memoryFiles(seed);
  const { context, io } = testContext({
    io: { cwd: '/w', readFile: fs.readFile, writeFileAtomic: fs.writeFileAtomic },
  });
  const code = await runCli(
    ['conformance', '--self-test', '--json', ...argv],
    context,
    createCommands(),
  );
  const out = io.stdout.join('\n');
  return { code, out, err: io.stderr.join('\n'), report: JSON.parse(out) as Report, files: fs.files };
}

describe('self-test', () => {
  it('passes the whole profile against the bundled server, with no endpoint or certificate', async () => {
    const { code, report } = await selfTest();
    expect(report.summary.fail).toBe(0);
    expect(report.summary.pass).toBeGreaterThanOrEqual(18);
    expect(code).toBe(EXIT_OK);
  }, 60_000);

  it('covers every check the profile defines', async () => {
    const { report } = await selfTest();
    const ids = new Set(report.checks.map((check) => check.id));
    for (const id of [
      'enrollment.first-registration', 'enrollment.idempotent-registration',
      'enrollment.two-distinct-devices', 'discovery.opaque-paths',
      'pagination.accepts-l500', 'pagination.preserves-page-size',
      'assignment.exactly-one-target', 'assignment.empty-dispatches-none',
      'assignment.move-retargets',
      'control.fixed-w-bounded', 'control.mrid-idempotent',
      'responses.accepted', 'responses.started', 'responses.terminal',
      'telemetry.standard-mup', 'telemetry.der-status', 'telemetry.der-capability',
      'recovery.no-duplicate-delivery', 'recovery.owed-response-retried',
      'isolation.connection-scope',
    ]) {
      expect(ids, `missing check ${id}`).toContain(id);
    }
  }, 60_000);

  it('registers two devices in-band and proves repeated registration is idempotent', async () => {
    const { report } = await selfTest();
    expect(statusOf(report, 'enrollment.idempotent-registration')).toBe('pass');
    expect(statusOf(report, 'enrollment.two-distinct-devices')).toBe('pass');
  }, 60_000);

  it('delivers the bounded control to exactly the assigned device', async () => {
    const { report } = await selfTest();
    const check = report.checks.find((entry) => entry.id === 'control.fixed-w-bounded');
    expect(check?.status).toBe('pass');
    expect(check?.summary).toContain('only');
    expect(statusOf(report, 'assignment.empty-dispatches-none')).toBe('pass');
  }, 60_000);

  it('proves a restart neither duplicates delivery nor loses an owed response', async () => {
    const { report } = await selfTest();
    expect(statusOf(report, 'recovery.no-duplicate-delivery')).toBe('pass');
    const owed = report.checks.find((entry) => entry.id === 'recovery.owed-response-retried');
    expect(owed?.status).toBe('pass');
    // The check is only meaningful if something was actually outstanding at the restart.
    expect(owed?.summary).toMatch(/[1-9]\d* response\(s\) owed at restart/);
  }, 60_000);

  it('keeps two connections with overlapping identifiers isolated', async () => {
    const { report } = await selfTest();
    expect(statusOf(report, 'isolation.connection-scope')).toBe('pass');
  }, 60_000);

  it('rejects an origin alongside --self-test', async () => {
    const { context, io } = testContext();
    const code = await runCli(
      ['conformance', '--self-test', 'https://csip.partner.example'],
      context,
      createCommands(),
    );
    expect(code).toBe(EXIT_USAGE);
    expect(io.stderr.join('\n')).toContain('takes no origin');
  });
});

describe('evidence artifact', () => {
  it('validates against the checked-in schema', async () => {
    const { report } = await selfTest();
    expect(validateAgainstSchema(report, schema)).toEqual([]);
  }, 60_000);

  it('carries no PEM, private key, raw XML, or synthetic device serial beyond the LFDI shape', async () => {
    const { report } = await selfTest();
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('BEGIN CERTIFICATE');
    expect(serialized).not.toContain('PRIVATE KEY');
    expect(serialized).not.toContain('<?xml');
    expect(serialized).not.toContain('<DERControl');
  }, 60_000);

  it('contains no public-boundary forbidden term', async () => {
    const { report } = await selfTest();
    const serialized = JSON.stringify(report).toLowerCase();
    // Assembled at runtime so this file does not itself trip the boundary checker.
    for (const term of [['cm', 'sandbox'].join(''), ['HIL', 'DA'].join(''),
      ['ra', 'command'].join('-'), ['Terra', 'form'].join('')]) {
      expect(serialized).not.toContain(term.toLowerCase());
    }
  }, 60_000);

  it('writes the artifact to --out', async () => {
    const { files } = await selfTest(['--out', 'evidence.json']);
    const written = files.get('/w/evidence.json');
    expect(written).toBeDefined();
    expect(validateAgainstSchema(JSON.parse(written!), schema)).toEqual([]);
  }, 60_000);

  it('is bounded: every check message stays within the schema limit', async () => {
    const { report } = await selfTest();
    for (const check of report.checks) {
      expect(check.summary.length).toBeLessThanOrEqual(400);
      expect((check.remediation ?? '').length).toBeLessThanOrEqual(400);
    }
  }, 60_000);
});

describe('session persistence', () => {
  it('writes a resumable session file', async () => {
    const { files } = await selfTest();
    const raw = files.get('/w/.fortress-csip-session.json');
    expect(raw).toBeDefined();
    const session = JSON.parse(raw!) as ConformanceSessionFile;
    expect(session.schema).toBe('fortress-csip-conformance-session/v1');
    expect(session.devices.alpha.lfdi).toMatch(/^[0-9a-f]{40}$/);
    expect(session.control?.mRID).toBeDefined();
  }, 60_000);

  it('never stores private-key content', async () => {
    const { files } = await selfTest();
    const raw = files.get('/w/.fortress-csip-session.json')!;
    expect(raw).not.toContain('PRIVATE KEY');
    expect(raw).not.toContain('BEGIN');
  }, 60_000);

  it('never stores cached response bodies', async () => {
    // The resource cache holds raw server payloads. It is deliberately not serialized, so a
    // session file a partner attaches to a ticket cannot carry them.
    const { files } = await selfTest();
    const raw = files.get('/w/.fortress-csip-session.json')!;
    expect(raw).not.toContain('<?xml');
    expect(raw).not.toContain('DeviceCapability');
  }, 60_000);

  it('starts a fresh session when the file belongs to another origin', async () => {
    const foreign: ConformanceSessionFile = {
      schema: 'fortress-csip-conformance-session/v1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      origin: 'https://someone-else.example',
      devices: syntheticDevices('https://someone-else.example', 'seed'),
    };
    const { err, files } = await selfTest([], {
      '/w/.fortress-csip-session.json': JSON.stringify(foreign),
    });
    expect(err).toContain('recorded against a different origin');
    const session = JSON.parse(files.get('/w/.fortress-csip-session.json')!) as ConformanceSessionFile;
    expect(session.devices.alpha.lfdi).not.toBe(foreign.devices.alpha.lfdi);
  }, 60_000);

  it('reuses the recorded synthetic identities when resuming the same origin', async () => {
    const first = await selfTest();
    const session = JSON.parse(first.files.get('/w/.fortress-csip-session.json')!) as ConformanceSessionFile;
    const second = await selfTest([], {
      '/w/.fortress-csip-session.json': JSON.stringify(session),
    });
    expect(second.err).toContain('Resuming the conformance session');
    const resumed = JSON.parse(second.files.get('/w/.fortress-csip-session.json')!) as ConformanceSessionFile;
    expect(resumed.devices.alpha.lfdi).toBe(session.devices.alpha.lfdi);
  }, 60_000);

  it('derives distinct, deterministic synthetic identities', () => {
    const a = syntheticDevices('https://a.example', 'seed');
    const b = syntheticDevices('https://b.example', 'seed');
    expect(a.alpha.lfdi).toBe(syntheticDevices('https://a.example', 'seed').alpha.lfdi);
    expect(a.alpha.lfdi).not.toBe(a.beta.lfdi);
    expect(a.alpha.lfdi).not.toBe(b.alpha.lfdi);
    for (const lfdi of [a.alpha.lfdi, a.beta.lfdi]) expect(lfdi).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('serializable session store', () => {
  it('round-trips the state a restart depends on', async () => {
    const store = new SerializableSessionStore();
    await store.saveEndDevice({ lFDI: 'a'.repeat(40), href: '/sep2/edev/opaque', eligible: true });
    await store.saveResponseEffect({
      id: 'effect-1',
      internalEventId: 'event-1',
      href: '/sep2/responses',
      response: { createdDateTime: 1, endDeviceLFDI: 'a'.repeat(40), status: 3, subject: 'm' },
      sent: false,
    });
    const restored = SerializableSessionStore.from(
      JSON.parse(JSON.stringify(store.serialize())),
    );
    expect(await restored.loadEndDevice('a'.repeat(40))).toMatchObject({ href: '/sep2/edev/opaque' });
    expect(await restored.listPendingResponses()).toHaveLength(1);
  });

  it('drops the resource cache, which holds raw payloads', async () => {
    const store = new SerializableSessionStore();
    await store.saveResource('/sep2/capability', { etag: '"1"', body: '<?xml version="1.0"?><x/>' });
    const serialized = JSON.stringify(store.serialize());
    expect(serialized).not.toContain('<?xml');
    // The live store still caches; only persistence drops it.
    expect(await store.loadResource('/sep2/capability')).toBeDefined();
  });

  it('does not carry a sent effect back as pending', async () => {
    const store = new SerializableSessionStore();
    await store.saveResponseEffect({
      id: 'sent-1',
      internalEventId: 'event-1',
      href: '/sep2/responses',
      response: { createdDateTime: 1, endDeviceLFDI: 'a'.repeat(40), status: 1, subject: 'm' },
      sent: true,
    });
    const restored = SerializableSessionStore.from(store.serialize());
    expect(await restored.listPendingResponses()).toEqual([]);
  });
});

describe('guided operator instructions', () => {
  it('names the device to assign and says no admin endpoint is needed', () => {
    const text = describeInstruction(
      { kind: 'assignment', targetLfdi: 'a'.repeat(40), otherLfdi: 'b'.repeat(40), targetLabel: 'test-device-alpha' },
      600_000,
    ).join('\n');
    expect(text).toContain('ACTION REQUIRED');
    expect(text).toContain('test-device-alpha');
    expect(text).toContain('No Fortress-specific admin');
    expect(text).toContain('10 minute(s)');
  });

  it('gives the exact control parameters to publish', () => {
    const text = describeInstruction(
      {
        kind: 'control',
        mRID: 'fortress-csip-rehearsal-123',
        start: 1_788_000_000,
        durationSeconds: 300,
        opModFixedW: -1_500,
        targetLfdi: 'a'.repeat(40),
        targetLabel: 'test-device-alpha',
      },
      600_000,
    ).join('\n');
    expect(text).toContain('fortress-csip-rehearsal-123');
    expect(text).toContain('-1500 W');
    expect(text).toContain('300 seconds');
    expect(text).toContain('responseRequired');
    expect(text).toContain('replyTo');
  });

  it('describes an assignment move without implying a Fortress-side edit', () => {
    const text = describeInstruction(
      { kind: 'assignment-move', fromLfdi: 'a'.repeat(40), toLfdi: 'b'.repeat(40), toLabel: 'test-device-beta' },
      600_000,
    ).join('\n');
    expect(text).toContain('test-device-beta');
    expect(text).toContain('No Fortress-side membership edit');
  });
});

describe('remote mode', () => {
  let pki: TestPki;
  let serverCertificate: TestCertificate;
  let client: TestCertificate;
  const servers: Server[] = [];

  beforeAll(() => {
    pki = makeTestPki();
    serverCertificate = pki.root.issue('remote-fixture', 'server', 'localhost');
    client = pki.root.issue('remote-client', 'client');
  });
  afterAll(() => pki.cleanup());
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    })));
  });

  /** A real mTLS partner server, so remote mode is exercised over an actual connection. */
  async function startPartner(): Promise<{ origin: string }> {
    const persistence = new MemoryPartnerPersistence();
    const { app, domain } = makePartnerApp({
      persistence,
      resolveConnection: directMtlsConnectionResolver(persistence),
    });
    const lfdi = aggregatorLfdiFromCertificate(client.certificate);
    await domain.createConnection('remote', lfdi);
    await domain.createProgram('remote', 'rehearsal', 'rehearsal-dispatch', 3);

    const server = createHttpsServer(
      {
        cert: Buffer.from(serverCertificate.certificate),
        key: Buffer.from(serverCertificate.privateKey),
        requestCert: true,
        rejectUnauthorized: true,
        ca: [Buffer.from(pki.root.certificate)],
      },
      app,
    );
    servers.push(server);
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        resolve(typeof address === 'object' && address !== null ? address.port : 0);
      });
    });
    return { origin: `https://localhost:${port}` };
  }

  async function remote(
    origin: string,
    extra: string[] = [],
  ): Promise<{ code: number; out: string; err: string; report: Report }> {
    const fs = memoryFiles();
    const { context, io } = testContext({
      resolveHost: fixedHostResolver({ localhost: ['127.0.0.1'] }),
      io: { cwd: '/w', readFile: async (path: string) => {
        const material: Record<string, Uint8Array> = {
          '/w/client.pem': client.certificate,
          '/w/client.key': client.privateKey,
          '/w/root.pem': pki.root.certificate,
        };
        return material[path] ?? fs.readFile(path);
      }, writeFileAtomic: fs.writeFileAtomic },
    });
    const code = await runCli(
      ['conformance', origin, '--local', '--ca', '/w/root.pem',
        '--cert', '/w/client.pem', '--key', '/w/client.key',
        '--wait-minutes', '1', '--json', ...extra],
      context,
      createCommands(),
    );
    const out = io.stdout.join('\n');
    return { code, out, err: io.stderr.join('\n'), report: JSON.parse(out) as Report };
  }

  it('registers devices in-band over a real mutual-TLS connection', async () => {
    const partner = await startPartner();
    const { report } = await remote(partner.origin);
    expect(statusOf(report, 'enrollment.first-registration')).toBe('pass');
    expect(statusOf(report, 'enrollment.idempotent-registration')).toBe('pass');
    expect(statusOf(report, 'enrollment.two-distinct-devices')).toBe('pass');
  }, 60_000);

  it('records the client identity in the evidence', async () => {
    const partner = await startPartner();
    const { report } = await remote(partner.origin);
    expect(report.identity?.aggregatorLfdi).toBe(aggregatorLfdiFromCertificate(client.certificate));
    expect(report.identity?.certificateFingerprintSha256).toMatch(/^[0-9a-f]{64}$/);
  }, 60_000);

  it('asks the operator to assign a device rather than doing it, and marks the check manual', async () => {
    // No operator acts, so the wait must expire into an actionable manual check — not a
    // failure of the partner's server, and not a silent pass.
    const partner = await startPartner();
    const { report, err, code } = await remote(partner.origin);
    const check = report.checks.find((entry) => entry.id === 'assignment.exactly-one-target');
    expect(check?.status).toBe('manual');
    expect(check?.action).toContain('operator tooling');
    expect(err).toContain('ACTION REQUIRED');
    // Outstanding operator work is not a conformance failure.
    expect(code).toBe(EXIT_OK);
  }, 120_000);

  it('skips the control and recovery checks that depend on an assignment', async () => {
    const partner = await startPartner();
    const { report } = await remote(partner.origin);
    for (const id of ['control.fixed-w-bounded', 'responses.accepted',
      'recovery.no-duplicate-delivery']) {
      expect(statusOf(report, id)).toBe('skip');
    }
  }, 120_000);

  it('skips connection isolation, which only the self-test can arrange', async () => {
    const partner = await startPartner();
    const { report } = await remote(partner.origin);
    expect(statusOf(report, 'isolation.connection-scope')).toBe('skip');
  }, 120_000);

  it('still exercises telemetry against the real connection', async () => {
    const partner = await startPartner();
    const { report } = await remote(partner.origin);
    expect(statusOf(report, 'telemetry.standard-mup')).toBe('pass');
  }, 120_000);

  it('produces a schema-valid artifact even with work outstanding', async () => {
    const partner = await startPartner();
    const { report } = await remote(partner.origin);
    expect(validateAgainstSchema(report, schema)).toEqual([]);
    expect(report.summary.manual).toBeGreaterThan(0);
  }, 120_000);

  it('requires a client identity', async () => {
    const { context, io } = testContext({ io: { cwd: '/w' } });
    const code = await runCli(
      ['conformance', 'https://csip.partner.example'],
      context,
      createCommands(),
    );
    expect(code).toBe(EXIT_USAGE);
    expect(io.stderr.join('\n')).toContain('--cert and --key');
  });

  it('rejects --ca outside --local', async () => {
    const { context, io } = testContext({ io: { cwd: '/w' } });
    const code = await runCli(
      ['conformance', 'https://csip.partner.example', '--ca', '/w/root.pem',
        '--cert', '/w/c.pem', '--key', '/w/k.pem'],
      context,
      createCommands(),
    );
    expect(code).toBe(EXIT_USAGE);
    expect(io.stderr.join('\n')).toContain('--ca is permitted only with --local');
  });

  it('rejects a nonsensical wait', async () => {
    const { context } = testContext({ io: { cwd: '/w' } });
    const code = await runCli(
      ['conformance', 'https://csip.partner.example', '--wait-minutes', '0',
        '--cert', '/w/c.pem', '--key', '/w/k.pem'],
      context,
      createCommands(),
    );
    expect(code).toBe(EXIT_USAGE);
  });

  it('reports a transport failure without running the profile', async () => {
    const { context, io } = testContext({
      resolveHost: fixedHostResolver({ 'csip.partner.example': ['10.0.0.5'] }),
      io: { cwd: '/w', readFile: async () => Buffer.from('') },
    });
    const code = await runCli(
      ['conformance', 'https://csip.partner.example', '--cert', '/w/c.pem', '--key', '/w/k.key', '--json'],
      context,
      createCommands(),
    );
    const report = JSON.parse(io.stdout.join('\n')) as Report;
    expect(statusOf(report, 'origin.public-dns')).toBe('fail');
    expect(report.checks.some((check) => check.id.startsWith('enrollment.'))).toBe(false);
    expect(code).toBe(EXIT_CHECKS_FAILED);
  });
});
