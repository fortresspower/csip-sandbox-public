import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { createCommands } from '../src/commands/index.js';
import { HANDOFF_SCHEMA } from '../src/commands/onboarding.js';
import { EXIT_CHECKS_FAILED, EXIT_OK, EXIT_USAGE } from '../src/errors.js';
import { testContext } from './support/context.js';

function files(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    readFile: async (path: string): Promise<Uint8Array> => {
      const contents = store.get(path);
      if (contents === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return Buffer.from(contents, 'utf8');
    },
    writeFileAtomic: async (path: string, contents: string): Promise<void> => {
      store.set(path, contents);
    },
  };
}

async function onboarding(
  argv: string[] = [],
  seed: Record<string, string> = {},
): Promise<{ code: number; out: string; err: string; store: Map<string, string> }> {
  const fs = files(seed);
  const { context, io } = testContext({
    io: { cwd: '/w', readFile: fs.readFile, writeFileAtomic: fs.writeFileAtomic },
  });
  const code = await runCli(['onboarding', ...argv], context, createCommands());
  return { code, out: io.stdout.join('\n'), err: io.stderr.join('\n'), store: fs.store };
}

const COMPLETE = {
  schema: HANDOFF_SCHEMA,
  origin: 'https://csip.example.org',
  technicalContact: { name: 'A. Engineer', email: 'eng@example.org' },
  operationsContact: { name: 'B. Operator', email: 'ops@example.org' },
  requestedFleetTier: { sites: 1000, standardTelemetrySeconds: 300 },
  evidenceFile: 'fortress-csip-evidence.json',
};

describe('the handoff contract', () => {
  it('states who is client and who is server', async () => {
    const { out, code } = await onboarding();
    expect(out).toContain('Fortress acts as the IEEE 2030.5 client.');
    expect(out).toContain('Your system hosts the IEEE 2030.5 server.');
    expect(code).toBe(EXIT_OK);
  });

  it('lists what each side provides', async () => {
    const { out } = await onboarding();
    expect(out).toContain('public HTTPS origin on TCP 443');
    expect(out).toContain('technical contact and an operations contact');
    expect(out).toContain('completed conformance evidence artifact');
    expect(out).toContain('public chain for one connection-specific client certificate');
    expect(out).toContain('aggregator LFDI derived from that certificate leaf');
    expect(out).toContain('SHA-256 fingerprint and expiry');
    expect(out).toContain('stable connection identifier');
    expect(out).toContain('proposed preflight window');
  });

  it('says the partner installs the issuer AND allowlists the LFDI', async () => {
    const { out } = await onboarding();
    expect(out).toContain('install and trust the supplied Fortress client issuer');
    expect(out).toContain('allowlist the exact aggregator LFDI');
    expect(out).toContain('Either alone');
  });

  it('forbids private-key and per-device-roster exchange', async () => {
    const { out } = await onboarding();
    expect(out).toContain('Never exchanged');
    expect(out).toContain('private key');
    expect(out).toContain('per-device roster');
  });

  it('describes the no-control phase before a bounded command rehearsal', async () => {
    const { out } = await onboarding();
    expect(out).toContain('without executing controls');
    expect(out).toContain('bounded command rehearsal');
  });

  it('offers the same contract as JSON', async () => {
    const { out } = await onboarding(['--json']);
    const parsed = JSON.parse(out) as { integrationModel: { client: string; server: string } };
    expect(parsed.integrationModel.client).toBe('Fortress');
    expect(parsed.integrationModel.server).toBe('Partner');
  });

  it('names no Fortress-private service', async () => {
    const { out } = await onboarding();
    for (const term of [['cm', 'sandbox'].join(''), ['HIL', 'DA'].join(''),
      ['ra', 'command'].join('-'), ['Terra', 'form'].join('')]) {
      expect(out.toLowerCase()).not.toContain(term.toLowerCase());
    }
  });
});

describe('submission template', () => {
  it('matches the documented schema', async () => {
    const { out } = await onboarding(['--template']);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.schema).toBe(HANDOFF_SCHEMA);
    expect(parsed).toHaveProperty('technicalContact');
    expect(parsed).toHaveProperty('operationsContact');
    expect(parsed).toHaveProperty('requestedFleetTier');
    expect(parsed).toHaveProperty('evidenceFile');
  });

  it('writes to --out', async () => {
    const { store } = await onboarding(['--template', '--out', 'handoff.json']);
    const written = store.get('/w/handoff.json');
    expect(written).toBeDefined();
    expect((JSON.parse(written!) as { schema: string }).schema).toBe(HANDOFF_SCHEMA);
  });

  it('cannot be combined with --validate', async () => {
    const { code, err } = await onboarding(['--template', '--validate', 'x.json']);
    expect(code).toBe(EXIT_USAGE);
    expect(err).toContain('cannot be combined');
  });
});

describe('submission validation', () => {
  it('accepts a complete submission', async () => {
    const { code, out } = await onboarding(['--validate', 'h.json'], {
      '/w/h.json': JSON.stringify(COMPLETE),
    });
    expect(code).toBe(EXIT_OK);
    expect(out).toContain('complete Fortress CSIP handoff submission');
  });

  it('rejects the unedited template placeholder', async () => {
    const { code, out } = await onboarding(['--validate', 'h.json'], {
      '/w/h.json': JSON.stringify({ ...COMPLETE, origin: 'https://csip.partner.example' }),
    });
    expect(code).toBe(EXIT_CHECKS_FAILED);
    expect(out).toContain('still the placeholder');
  });

  it('rejects a non-HTTPS origin and a non-443 port', async () => {
    const http = await onboarding(['--validate', 'h.json'], {
      '/w/h.json': JSON.stringify({ ...COMPLETE, origin: 'http://csip.example.org' }),
    });
    expect(http.out).toContain('must use HTTPS');
    const port = await onboarding(['--validate', 'h.json'], {
      '/w/h.json': JSON.stringify({ ...COMPLETE, origin: 'https://csip.example.org:8443' }),
    });
    expect(port.out).toContain('TCP 443');
  });

  it('reports every missing contact field', async () => {
    const { out } = await onboarding(['--validate', 'h.json'], {
      '/w/h.json': JSON.stringify({
        ...COMPLETE,
        technicalContact: { name: '', email: '' },
        operationsContact: { name: 'x', email: 'not-an-address' },
      }),
    });
    expect(out).toContain('technicalContact.name is empty');
    expect(out).toContain('technicalContact.email');
    expect(out).toContain('operationsContact.email');
  });

  it('rejects a nonsensical fleet tier', async () => {
    const { out } = await onboarding(['--validate', 'h.json'], {
      '/w/h.json': JSON.stringify({ ...COMPLETE, requestedFleetTier: { sites: 0, standardTelemetrySeconds: -1 } }),
    });
    expect(out).toContain('requestedFleetTier.sites');
    expect(out).toContain('standardTelemetrySeconds');
  });

  it('refuses a submission carrying private-key material', async () => {
    // The one mistake worth refusing loudly: a key pasted into a file about to be emailed.
    const { code, out } = await onboarding(['--validate', 'h.json'], {
      '/w/h.json': JSON.stringify({
        ...COMPLETE,
        note: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----',
      }),
    });
    expect(code).toBe(EXIT_CHECKS_FAILED);
    expect(out).toContain('private-key material');
    expect(out).toContain('rotate that key');
  });

  it('reports an unreadable or malformed file rather than crashing', async () => {
    const missing = await onboarding(['--validate', 'nope.json']);
    expect(missing.code).toBe(EXIT_CHECKS_FAILED);
    expect(missing.err).toContain('could not read');

    const malformed = await onboarding(['--validate', 'h.json'], { '/w/h.json': 'not json' });
    expect(malformed.code).toBe(EXIT_CHECKS_FAILED);
  });

  it('rejects a wrong schema', async () => {
    const { out } = await onboarding(['--validate', 'h.json'], {
      '/w/h.json': JSON.stringify({ ...COMPLETE, schema: 'something-else/v9' }),
    });
    expect(out).toContain('schema must be');
  });
});
