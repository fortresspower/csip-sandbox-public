import type { Command, CommandContext } from '../command.js';
import { EXIT_OK, type ExitCode } from '../errors.js';
import { topLevelHelp } from '../help.js';

/**
 * `help` exists as a registered command so it appears in the command table, but the dispatcher
 * intercepts it before reaching here — that is what keeps bare invocation, `help`, and
 * `--help` identical. This handler is the fallback for that same rendering.
 */
export function helpCommand(commands: () => readonly Command[]): Command {
  return {
    name: 'help',
    arguments: '',
    summary: 'Show this help',
    help: () =>
      [
        'fortress-csip help [command]',
        '',
        'Show the toolkit overview, or detailed help for one command.',
        '',
        'These are equivalent:',
        '  fortress-csip',
        '  fortress-csip help',
        '  fortress-csip --help',
      ].join('\n'),
    run: async (_argv: string[], context: CommandContext): Promise<ExitCode> => {
      context.io.out(topLevelHelp(commands()));
      return EXIT_OK;
    },
  };
}
