import { execFile as execFileCallback } from 'node:child_process';
import { appendFile, cp, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildReleaseBundle,
  smokeInstallRelease,
  verifyReleaseBundle,
} from '../scripts/release-bundle.mjs';

const execFile = promisify(execFileCallback);
const SOURCE_COMMIT = '0123456789abcdef0123456789abcdef01234567';
let temporary: string;
let first: string;
let second: string;

beforeAll(async () => {
  await execFile('npm', ['run', 'build', '--', '--force']);
  temporary = await mkdtemp(join(tmpdir(), 'csip-release-test-'));
  first = join(temporary, 'first');
  second = join(temporary, 'second');
  await buildReleaseBundle({ outputDir: first, sourceCommit: SOURCE_COMMIT });
  await buildReleaseBundle({ outputDir: second, sourceCommit: SOURCE_COMMIT });
}, 60_000);

afterAll(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

describe('client-core release bundle', () => {
  it('is byte-reproducible and records the exact private protocol runtime', async () => {
    const [a, b] = await Promise.all([
      verifyReleaseBundle(first),
      verifyReleaseBundle(second),
    ]);

    expect(a).toEqual(b);
    expect(a.sourceCommit).toBe(SOURCE_COMMIT);
    expect(a.package).toEqual({ name: '@fortress-csip/client-core', version: '0.4.0' });
    expect(a.protocolRuntime).toEqual(expect.objectContaining({
      name: '@fortress-csip/protocol',
      version: '0.1.0',
      entry: 'vendor/protocol.js',
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
    expect(a.protocolRuntime.bundledPackages).toContain('fast-xml-parser');
    expect(a.files.some((file: { path: string }) => file.path === 'vendor/protocol.js')).toBe(true);
    expect(a.files.every((file: { path: string }) => !file.path.includes('/src/'))).toBe(true);
    expect(await readFile(join(first, a.tarball.file))).toEqual(await readFile(join(second, b.tarball.file)));
  });

  it('installs offline into an empty JavaScript and TypeScript consumer without protocol exports', async () => {
    await expect(smokeInstallRelease(first)).resolves.toEqual(expect.objectContaining({
      sourceCommit: SOURCE_COMMIT,
    }));
  }, 30_000);

  it('fails verification when tarball bytes or checksum files drift', async () => {
    const corrupt = join(temporary, 'corrupt');
    const missing = join(temporary, 'missing');
    const unsafe = join(temporary, 'unsafe');
    await cp(first, corrupt, { recursive: true });
    await cp(first, missing, { recursive: true });
    await cp(first, unsafe, { recursive: true });
    const manifest = JSON.parse(await readFile(join(corrupt, 'manifest.json'), 'utf8'));
    await appendFile(join(corrupt, manifest.tarball.file), 'tampered');
    await unlink(join(missing, 'SHA256SUMS'));
    const unsafeManifest = JSON.parse(await readFile(join(unsafe, 'manifest.json'), 'utf8'));
    unsafeManifest.tarball.file = '../outside.tgz';
    await writeFile(join(unsafe, 'manifest.json'), `${JSON.stringify(unsafeManifest, null, 2)}\n`);

    await expect(verifyReleaseBundle(corrupt)).rejects.toThrow(/checksum drift/i);
    await expect(verifyReleaseBundle(missing)).rejects.toThrow(/required release input is missing/i);
    await expect(verifyReleaseBundle(unsafe)).rejects.toThrow(/safe relative path/i);
  });
});
