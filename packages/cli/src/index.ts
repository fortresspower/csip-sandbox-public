/**
 * Library surface of the toolkit CLI.
 *
 * Importing this module never runs a command and never touches the process. The executable
 * entry point is `main.ts`; keeping the two apart is what lets tests drive the real dispatch
 * logic in-process with an in-memory console.
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveNodeHost } from './adapters/dns.js';
import { runNodeProcess } from './adapters/process.js';
import type { CommandContext } from './command.js';
import { createNodeIo } from './io.js';
import { findRepositoryRoot } from './repository.js';

export { runCli } from './cli.js';
export type { Command, CommandContext } from './command.js';
export { createCommands } from './commands/index.js';
export * from './errors.js';
export { INTEGRATION_MODEL, JOURNEY, topLevelHelp } from './help.js';
export { createMemoryIo, createNodeIo, type Io } from './io.js';
export { findRepositoryRoot } from './repository.js';
export { TOOL_NAME, TOOL_VERSION } from './version.js';

/** Build the real, process-backed context. Tests construct their own. */
export async function createNodeContext(
  overrides: Partial<CommandContext> = {},
): Promise<CommandContext> {
  return {
    io: createNodeIo(),
    runProcess: runNodeProcess,
    resolveHost: resolveNodeHost,
    fetch: globalThis.fetch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    repositoryRoot: await findRepositoryRoot(dirname(fileURLToPath(import.meta.url))),
    ...overrides,
  };
}
