import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandContext } from '../../src/command.js';
import { createMemoryIo, type Io } from '../../src/io.js';
import type { ProcessRunner } from '../../src/adapters/process.js';
import type { HostResolver } from '../../src/adapters/dns.js';

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

type MemoryIo = ReturnType<typeof createMemoryIo>;

/**
 * A context with every seam faked.
 *
 * The default process runner and resolver throw: a test that reaches Docker or DNS without
 * saying so is a test that would behave differently on another machine, and it should fail
 * loudly rather than skip.
 */
export function testContext(
  overrides: Partial<CommandContext> & { io?: Partial<Io> } = {},
): { context: CommandContext; io: MemoryIo } {
  const { io: ioOverrides, ...contextOverrides } = overrides;
  const io = createMemoryIo(ioOverrides);
  const context: CommandContext = {
    io,
    runProcess: unexpected('runProcess'),
    resolveHost: unexpected('resolveHost') as unknown as HostResolver,
    fetch: unexpected('fetch') as unknown as typeof globalThis.fetch,
    // Tests do not wait: polling loops are bounded by the injected clock and attempt count.
    sleep: async () => {},
    repositoryRoot: REPOSITORY_ROOT,
    ...contextOverrides,
  };
  return { context, io };
}

function unexpected(name: string): ProcessRunner {
  return async () => {
    throw new Error(`test context: ${name} was called but no fake was provided`);
  };
}
