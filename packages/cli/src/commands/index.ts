import type { Command } from '../command.js';
import { demoCommand } from './demo.js';
import { helpCommand } from './help-command.js';
import { lfdiCommand } from './lfdi.js';

/**
 * The command registry, in the order the journey runs.
 *
 * `help` is first because it is the entry point; the rest follow
 * demo → doctor → conformance → connect, with the certificate utility alongside.
 */
export function createCommands(): Command[] {
  const commands: Command[] = [];
  commands.push(helpCommand(() => commands));
  commands.push(demoCommand());
  commands.push(lfdiCommand());
  return commands;
}
