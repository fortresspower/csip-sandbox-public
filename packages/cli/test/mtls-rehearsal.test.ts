import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { createCommands } from '../src/commands/index.js';
import { EXIT_OK, EXIT_USAGE } from '../src/errors.js';
import { MTLS_CHECK_IDS } from '../src/mtls/rehearsal.js';
import { createDisposablePki, type DisposablePki } from '../src/mtls/test-pki.js';
import { validateAgainstSchema } from '../src/report/validate.js';
import type { Report } from '../src/report/types.js';
import { REPOSITORY_ROOT, testContext } from './support/context.js';

/**
 * The rehearsal generates real key material and stands up a real TLS listener, so these tests
 * exercise it end to end rather than mocking it. That is the point: the four outcomes it
 * reports are only meaningful if they came from an actual handshake.
 */

const leftovers: DisposablePki[] = [];
afterAll(async () => Promise.all(leftovers.splice(0).map((pki) => pki.cleanup())));

async function rehearse(
  argv: string[] = [],
): Promise<{ code: number; out: string; err: string; report?: Report }> {
  const { context, io } = testContext({ io: { cwd: '/w' } });
  const code = await runCli(['demo', '--mtls', ...argv], context, createCommands());
  const out = io.stdout.join('\n');
  const jsonRequested = argv.includes('--json');
  return {
    code,
    out,
    err: io.stderr.join('\n'),
    report: jsonRequested ? (JSON.parse(out) as Report) : undefined,
  };
}

describe('the four identity outcomes', () => {
  it('passes all four against the production-shaped app', async () => {
    const { code, report } = await rehearse(['--json']);
    expect(report!.checks.map((check) => check.id)).toEqual([...MTLS_CHECK_IDS]);
    for (const check of report!.checks) expect(check.status).toBe('pass');
    expect(code).toBe(EXIT_OK);
  }, 60_000);

  it('serves a trusted, allowlisted identity', async () => {
    const { report } = await rehearse(['--json']);
    const check = report!.checks.find((entry) => entry.id === 'mtls.authorized-allowlisted');
    expect(check?.status).toBe('pass');
    expect(check?.summary).toMatch(/[0-9a-f]{40}/);
  }, 60_000);

  it('refuses a client presenting no certificate', async () => {
    const { report } = await rehearse(['--json']);
    expect(report!.checks.find((entry) => entry.id === 'mtls.missing-client-certificate')?.status)
      .toBe('pass');
  }, 60_000);

  it('refuses a client from an untrusted issuer', async () => {
    const { report } = await rehearse(['--json']);
    expect(report!.checks.find((entry) => entry.id === 'mtls.untrusted-client-issuer')?.status)
      .toBe('pass');
  }, 60_000);

  it('refuses a trusted client whose LFDI is not allowlisted', async () => {
    // The case partners most often get wrong: trusting the issuer is not authorization.
    const { report } = await rehearse(['--json']);
    const check = report!.checks.find((entry) => entry.id === 'mtls.trusted-but-not-allowlisted');
    expect(check?.status).toBe('pass');
    expect(check?.summary).toContain('not allowlisted');
  }, 60_000);
});

describe('report', () => {
  it('validates against the checked-in schema', async () => {
    const schema = JSON.parse(
      await readFile(join(REPOSITORY_ROOT, 'schemas/fortress-csip-evidence-v1.schema.json'), 'utf8'),
    );
    const { report } = await rehearse(['--json']);
    expect(validateAgainstSchema(report, schema)).toEqual([]);
    expect(report!.kind).toBe('mtls-rehearsal');
  }, 60_000);

  it('prints no private-key content on either stream', async () => {
    const { out, err } = await rehearse();
    for (const stream of [out, err]) {
      expect(stream).not.toContain('PRIVATE KEY');
      expect(stream).not.toContain('BEGIN');
    }
  }, 60_000);

  it('writes only JSON to stdout with --json, keeping progress on stderr', async () => {
    const { out, err } = await rehearse(['--json']);
    expect(() => JSON.parse(out)).not.toThrow();
    expect(err).toContain('Generating a disposable certificate authority');
  }, 60_000);

  it('says the key material was removed', async () => {
    const { out } = await rehearse();
    expect(out).toContain('All generated key material has been removed.');
  }, 60_000);

  it('writes the report to --out', async () => {
    const { context, io } = testContext({ io: { cwd: '/w' } });
    await runCli(['demo', '--mtls', '--out', 'rehearsal.json'], context, createCommands());
    const written = io.written.get('/w/rehearsal.json');
    expect(written).toBeDefined();
    expect((JSON.parse(written!) as Report).kind).toBe('mtls-rehearsal');
  }, 60_000);
});

describe('generated key material', () => {
  it('lives in a private directory with private keys', async () => {
    const pki = await createDisposablePki();
    leftovers.push(pki);
    const directoryMode = (await stat(pki.directory)).mode & 0o777;
    expect(directoryMode).toBe(0o700);

    const client = await pki.root.issue('probe-client', 'client');
    const keyMode = (await stat(client.privateKeyPath)).mode & 0o777;
    expect(keyMode).toBe(0o600);
  }, 60_000);

  it('is removed by cleanup, and cleanup is safe to repeat', async () => {
    const pki = await createDisposablePki();
    const { directory } = pki;
    await pki.cleanup();
    await pki.cleanup();
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 60_000);

  it('is removed when issuing a certificate fails partway', async () => {
    const pki = await createDisposablePki();
    leftovers.push(pki);
    // A common name that cannot be encoded fails inside openssl, after the directory exists.
    await expect(pki.root.issue('bad', 'client', 'x'.repeat(200))).rejects.toThrow();
    await pki.cleanup();
    await expect(stat(pki.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 60_000);

  it('names certificates conspicuously and keeps them short-lived', async () => {
    const pki = await createDisposablePki();
    leftovers.push(pki);
    const text = pki.root.certificate.toString('utf8');
    expect(text).toContain('BEGIN CERTIFICATE');
    // The subject is asserted through the issued leaf's own parsed metadata below.
    const { X509Certificate } = await import('node:crypto');
    const parsed = new X509Certificate(pki.root.certificate);
    expect(parsed.subject).toContain('REHEARSAL');
    expect(parsed.subject).toContain('NOT FOR PRODUCTION');
    const lifetimeDays =
      (Date.parse(parsed.validTo) - Date.parse(parsed.validFrom)) / 86_400_000;
    expect(lifetimeDays).toBeLessThanOrEqual(2);
  }, 60_000);

  it('issues from two unrelated roots', async () => {
    const pki = await createDisposablePki();
    leftovers.push(pki);
    const { X509Certificate } = await import('node:crypto');
    const root = new X509Certificate(pki.root.certificate);
    const foreign = new X509Certificate(pki.foreignRoot.certificate);
    expect(root.subject).not.toBe(foreign.subject);
    const client = await pki.foreignRoot.issue('foreign', 'client');
    expect(new X509Certificate(client.certificate).checkIssued(root)).toBe(false);
    expect(new X509Certificate(client.certificate).checkIssued(foreign)).toBe(true);
  }, 60_000);
});

describe('usage', () => {
  it('rejects --mtls with --detach', async () => {
    const { context, io } = testContext();
    const code = await runCli(['demo', '--mtls', '--detach'], context, createCommands());
    expect(code).toBe(EXIT_USAGE);
    expect(io.stderr.join('\n')).toContain('cannot be detached');
  });

  it('needs no Docker', async () => {
    // The test context throws if a command reaches the process runner, so a passing run here
    // is itself the assertion that the rehearsal spawned no Docker.
    const { code } = await rehearse(['--json']);
    expect(code).toBe(EXIT_OK);
  }, 60_000);

  it('is documented in demo help', async () => {
    const { context, io } = testContext();
    await runCli(['demo', '--help'], context, createCommands());
    expect(io.stdout.join('\n')).toContain('--mtls');
  });
});
