import type { Command, CommandContext } from './command.js';
import {
  EXIT_OK,
  EXIT_OPERATIONAL,
  EXIT_USAGE,
  OperationalError,
  UsageError,
  describeError,
  type ExitCode,
} from './errors.js';
import { topLevelHelp } from './help.js';
import { TOOL_NAME, TOOL_VERSION } from './version.js';

/**
 * Dispatch one invocation.
 *
 * Returns an exit code rather than calling `process.exit`, so the whole CLI can be driven
 * from a test in-process and asserted on. The executable wrapper is the only place that
 * touches the process.
 */
export async function runCli(
  argv: string[],
  context: CommandContext,
  commands: readonly Command[],
): Promise<ExitCode> {
  const [first, ...rest] = argv;

  // No arguments and a bare `--help` are the same front door as `help`, by construction.
  if (first === undefined || first === '--help' || first === '-h') {
    context.io.out(topLevelHelp(commands));
    return EXIT_OK;
  }

  if (first === '--version' || first === '-v') {
    context.io.out(`${TOOL_NAME} ${TOOL_VERSION}`);
    return EXIT_OK;
  }

  // `help <command>` is a convenience spelling of `<command> --help`. Rewrite it into that
  // form so both spellings take exactly one code path and cannot diverge. A bare `help`, or
  // `help` followed by a flag rather than a topic, stays a request for `help` itself.
  const isTopicForm = first === 'help' && rest[0] !== undefined && !rest[0].startsWith('-');
  const name = isTopicForm ? rest[0] : first;
  const commandArgv = isTopicForm ? rest.slice(1) : rest;

  const command = commands.find((candidate) => candidate.name === name);
  if (command === undefined) return unknownCommand(name, context, commands);

  // `help <command>` renders that command's help without running it, and every command
  // answers --help the same way.
  if (isTopicForm || commandArgv.includes('--help') || commandArgv.includes('-h')) {
    context.io.out(command.help());
    return EXIT_OK;
  }

  try {
    return await command.run(commandArgv, context);
  } catch (error) {
    return reportFailure(error, context, command.name);
  }
}

function unknownCommand(
  name: string,
  context: CommandContext,
  commands: readonly Command[],
): ExitCode {
  const suggestion = nearest(name, commands);
  context.io.err(`fortress-csip: unknown command "${name}"`);
  if (suggestion !== undefined) context.io.err(`  did you mean "${suggestion}"?`);
  context.io.err('  run `fortress-csip help` to see the available commands');
  return EXIT_USAGE;
}

function reportFailure(error: unknown, context: CommandContext, command: string): ExitCode {
  if (error instanceof UsageError) {
    context.io.err(`fortress-csip ${command}: ${error.message}`);
    context.io.err(`  run \`fortress-csip ${error.command ?? command} --help\` for usage`);
    return EXIT_USAGE;
  }
  if (error instanceof OperationalError) {
    context.io.err(`fortress-csip ${command}: ${error.message}`);
    if (error.remediation !== undefined) context.io.err(`  ${error.remediation}`);
    return EXIT_OPERATIONAL;
  }
  // Unexpected. Report the message only: an error object's cause chain or custom fields can
  // carry response payloads and key material, and this output is routinely pasted into
  // tickets.
  context.io.err(`fortress-csip ${command}: ${describeError(error)}`);
  return EXIT_OPERATIONAL;
}

/** Suggest a command within one edit of what was typed, for the common typo. */
function nearest(name: string, commands: readonly Command[]): string | undefined {
  let best: { name: string; distance: number } | undefined;
  for (const command of commands) {
    const distance = editDistance(name.toLowerCase(), command.name);
    if (distance <= 2 && (best === undefined || distance < best.distance)) {
      best = { name: command.name, distance };
    }
  }
  return best?.name;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}
