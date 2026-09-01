import type { Command } from '../command.js';
import { helpCommand } from './help-command.js';

/**
 * The command registry, in the order the journey runs.
 *
 * `help` is first because it is the entry point; the rest follow
 * demo → doctor → conformance → connect, with the certificate utility last.
 */
export function createCommands(): Command[] {
  const commands: Command[] = [];
  commands.push(helpCommand(() => commands));
  return commands;
}
