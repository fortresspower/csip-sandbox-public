import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aggregatorLfdiFromCertificate } from '@fortress-csip/client-core';
import { makeTestPki, type TestPki } from '../../client-core/test/test-certificates.js';
import { runCli } from '../src/cli.js';
import { createCommands } from '../src/commands/index.js';
import { EXIT_OK, EXIT_OPERATIONAL, EXIT_USAGE } from '../src/errors.js';
import { testContext } from './support/context.js';

let pki: TestPki;
let clientCertificate: Buffer;
let clientKey: Buffer;

beforeAll(() => {
  pki = makeTestPki();
  const issued = pki.root.issue('toolkit-test-client', 'client');
  clientCertificate = issued.certificate;
  clientKey = issued.privateKey;
});

afterAll(() => pki.cleanup());

/** Serve one named file from memory; anything else fails as it would on disk. */
function fileSystem(files: Record<string, Uint8Array>) {
  return async (path: string): Promise<Uint8Array> => {
    const contents = files[path];
    if (contents === undefined) {
      throw Object.assign(new Error(`ENOENT: no such file, open '${path}'`), { code: 'ENOENT' });
    }
    return contents;
  };
}

async function lfdi(
  argv: string[],
  files: Record<string, Uint8Array> = { '/w/client.pem': clientCertificate },
): Promise<{ code: number; out: string; err: string }> {
  const { context, io } = testContext({
    io: { cwd: '/w', readFile: fileSystem(files) },
  });
  const code = await runCli(['lfdi', ...argv], context, createCommands());
  return { code, out: io.stdout.join('\n'), err: io.stderr.join('\n') };
}

describe('lfdi', () => {
  it('reports the canonical LFDI, expiry, and fingerprint', async () => {
    const { code, out } = await lfdi(['/w/client.pem']);
    expect(code).toBe(EXIT_OK);
    expect(out).toContain(`Aggregator LFDI: ${aggregatorLfdiFromCertificate(clientCertificate)}`);
    expect(out).toMatch(/Expires: {9}\d{4}-\d{2}-\d{2}T[\d:.]+Z/);
    expect(out).toMatch(/SHA-256: {9}[0-9a-f]{64}$/m);
  });

  it('derives the same LFDI as client-core, not a second implementation', async () => {
    const { out } = await lfdi(['/w/client.pem']);
    const printed = /Aggregator LFDI: ([0-9a-f]{40})/.exec(out)?.[1];
    expect(printed).toBe(aggregatorLfdiFromCertificate(clientCertificate));
  });

  it('resolves a relative path against the working directory', async () => {
    const { code, out } = await lfdi(['client.pem']);
    expect(code).toBe(EXIT_OK);
    expect(out).toContain('Aggregator LFDI:');
  });

  it('prints only the value with --value-only, for scripting', async () => {
    const { code, out } = await lfdi(['/w/client.pem', '--value-only']);
    expect(code).toBe(EXIT_OK);
    expect(out).toBe(aggregatorLfdiFromCertificate(clientCertificate));
  });

  it('never prints a PEM body', async () => {
    const { out } = await lfdi(['/w/client.pem']);
    expect(out).not.toContain('BEGIN');
    expect(out).not.toContain('-----');
  });

  it('rejects a private key with an explanation, not a decoder error', async () => {
    const { code, err } = await lfdi(['/w/client.key'], { '/w/client.key': clientKey });
    expect(code).toBe(EXIT_USAGE);
    expect(err).toContain('private key, not a certificate');
  });

  it('rejects a file that is not a certificate at all', async () => {
    const { code, err } = await lfdi(['/w/notes.txt'], {
      '/w/notes.txt': Buffer.from('just some notes\n'),
    });
    expect(code).toBe(EXIT_USAGE);
    expect(err).toContain('X.509 certificate');
  });

  it('rejects an LFDI string passed where a certificate belongs', async () => {
    const { code, err } = await lfdi(['/w/lfdi.txt'], {
      '/w/lfdi.txt': Buffer.from('0123456789abcdef0123456789abcdef01234567'),
    });
    expect(code).toBe(EXIT_USAGE);
    expect(err).toContain('X.509 certificate');
  });

  it('reports an unreadable file as operational, not as bad usage', async () => {
    const { code, err } = await lfdi(['/w/missing.pem'], {});
    expect(code).toBe(EXIT_OPERATIONAL);
    expect(err).toContain('could not read');
  });

  it('requires exactly one argument', async () => {
    expect((await lfdi([])).code).toBe(EXIT_USAGE);
    expect((await lfdi(['a.pem', 'b.pem'])).code).toBe(EXIT_USAGE);
  });

  it('warns when the certificate is close to expiry', async () => {
    // The test PKI issues two-day certificates, so this is always within the warning window.
    const { out } = await lfdi(['/w/client.pem']);
    expect(out).toContain('Plan a rotation.');
  });
});
