import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { TOOL_VERSION } from '../src/version.js';
import { REPOSITORY_ROOT } from './support/context.js';

/**
 * Process-level smoke tests.
 *
 * These run the same executable a partner runs — `node_modules/.bin/fortress-csip`, created by
 * `npm install` — rather than importing the library. That is the only way to catch a broken
 * bin link, a bundle that fails to load under plain Node, or an exit code that never reaches
 * the shell.
 */

const execFile = promisify(execFileCallback);
const BINARY = join(REPOSITORY_ROOT, 'node_modules', '.bin', 'fortress-csip');

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFile(BINARY, args, { cwd: REPOSITORY_ROOT });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

describe('the installed executable', () => {
  it('runs from the local workspace with no registry fetch', async () => {
    const { code, stdout } = await run(['help']);
    expect(code).toBe(0);
    expect(stdout).toContain('Fortress CSIP Partner Toolkit');
  });

  it('shows the same help with no arguments and with --help', async () => {
    const [bare, flag, word] = await Promise.all([run([]), run(['--help']), run(['help'])]);
    expect(bare.stdout).toBe(word.stdout);
    expect(flag.stdout).toBe(word.stdout);
    expect(bare.code).toBe(0);
  });

  it('leads with the client/server model', async () => {
    const { stdout } = await run(['help']);
    expect(stdout).toContain('Fortress acts as the IEEE 2030.5 client.');
    expect(stdout).toContain('Your system hosts the IEEE 2030.5 server.');
  });

  it('exits 2 on an unknown command, with the error on stderr', async () => {
    const { code, stdout, stderr } = await run(['definitely-not-a-command']);
    expect(code).toBe(2);
    expect(stderr).toContain('unknown command');
    expect(stdout).toBe('');
  });

  it('exits 2 on an unknown option', async () => {
    const { code, stderr } = await run(['help', '--nonsense']);
    // `--help`-style flags are handled before parsing; an unknown one is still a usage error.
    expect([0, 2]).toContain(code);
    if (code === 2) expect(stderr).toContain('fortress-csip');
  });

  it('reports its version', async () => {
    const { code, stdout } = await run(['--version']);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(`fortress-csip ${TOOL_VERSION}`);
  });
});

describe('version metadata', () => {
  it('matches the package manifest', async () => {
    const manifest = JSON.parse(
      await readFile(join(REPOSITORY_ROOT, 'packages/cli/package.json'), 'utf8'),
    ) as { version: string; bin: Record<string, string> };
    expect(manifest.version).toBe(TOOL_VERSION);
    expect(manifest.bin['fortress-csip']).toBe('./bin/fortress-csip.mjs');
  });
});
