/**
 * Injected I/O for command handlers.
 *
 * Commands never touch `process`, `console`, `Date`, or the filesystem directly. Everything
 * they need arrives through this seam, so a test can assert on what a command wrote, what it
 * read, and what it would have run, without spawning a process or reaching a network.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface Io {
  /** Write a line to standard output. The newline is added for you. */
  out(line?: string): void;
  /** Write a line to standard error. */
  err(line?: string): void;
  /** Current time. Injected so reports are deterministic under test. */
  now(): Date;
  /** Read a file as bytes. Throws a plain Error on failure; callers wrap it. */
  readFile(path: string): Promise<Uint8Array>;
  /**
   * Write a file atomically: a sibling temporary file is written first and renamed over the
   * target, so an interrupted run cannot leave a half-written evidence artifact behind.
   */
  writeFileAtomic(path: string, contents: string): Promise<void>;
  /** Working directory, for resolving partner-supplied relative paths. */
  cwd: string;
  /** Process environment, read-only to commands. */
  env: Readonly<Record<string, string | undefined>>;
  /** True when the output stream is an interactive terminal. */
  isTty: boolean;
}

export function createNodeIo(overrides: Partial<Io> = {}): Io {
  return {
    out: (line = '') => process.stdout.write(`${line}\n`),
    err: (line = '') => process.stderr.write(`${line}\n`),
    now: () => new Date(),
    readFile: (path) => readFile(path),
    writeFileAtomic: async (path, contents) => {
      await mkdir(dirname(path), { recursive: true });
      const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
      await writeFile(temporary, contents, { mode: 0o600 });
      await rename(temporary, path);
    },
    cwd: process.cwd(),
    env: process.env,
    isTty: Boolean(process.stdout.isTTY),
    ...overrides,
  };
}

/** Collects output in memory. Tests assert against `stdout`/`stderr`. */
export function createMemoryIo(overrides: Partial<Io> = {}): Io & {
  stdout: string[];
  stderr: string[];
  written: Map<string, string>;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const written = new Map<string, string>();
  return {
    stdout,
    stderr,
    written,
    out: (line = '') => void stdout.push(line),
    err: (line = '') => void stderr.push(line),
    now: () => new Date('2026-09-01T14:00:00.000Z'),
    readFile: async () => {
      throw new Error('no filesystem in this test io');
    },
    writeFileAtomic: async (path, contents) => void written.set(path, contents),
    cwd: '/workspace',
    env: {},
    isTty: false,
    ...overrides,
  };
}
