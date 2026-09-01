/**
 * Executable entry point for `fortress-csip`.
 *
 * The only module in the package that touches the process. Commands return an exit category;
 * this maps it onto `process.exitCode` and lets Node exit naturally, so buffered stdout is
 * flushed before the process ends — `--json | jq` would otherwise lose its last chunk.
 */

import { runCli } from './cli.js';
import { createCommands } from './commands/index.js';
import { EXIT_OPERATIONAL, describeError } from './errors.js';
import { createNodeContext } from './index.js';
import { createNodeIo } from './io.js';

// `fortress-csip help | head` closes stdout early. Without this, Node raises an unhandled
// EPIPE and the command dies with a stack trace instead of the exit a pipeline expects.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(0);
    throw error;
  });
}

const io = createNodeIo();
try {
  const context = await createNodeContext({ io });
  process.exitCode = await runCli(process.argv.slice(2), context, createCommands());
} catch (error) {
  // Failures before a command is even selected: no checkout found, unreadable manifest.
  io.err(`fortress-csip: ${describeError(error)}`);
  process.exitCode = EXIT_OPERATIONAL;
}
