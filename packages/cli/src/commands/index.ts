import type { Command } from '../command.js';
import { conformanceCommand } from './conformance.js';
import { demoCommand } from './demo.js';
import { doctorCommand } from './doctor.js';
import { helpCommand } from './help-command.js';
import { lfdiCommand } from './lfdi.js';
import { onboardingCommand } from './onboarding.js';

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
  commands.push(doctorCommand());
  commands.push(conformanceCommand());
  commands.push(lfdiCommand());
  commands.push(onboardingCommand());
  return commands;
}
