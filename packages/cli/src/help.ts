import type { Command } from './command.js';

/**
 * The integration model, stated before anything else on every top-level help invocation.
 *
 * This is the single fact partners most often get backwards, and getting it backwards costs
 * weeks: they build a client and wait for Fortress to host a server. It leads the help output
 * for that reason.
 */
export const INTEGRATION_MODEL = [
  'Fortress acts as the IEEE 2030.5 client.',
  'Your system hosts the IEEE 2030.5 server.',
];

/** The journey the commands are ordered around. */
export const JOURNEY = 'demo → build your server → doctor → conformance → connect to Fortress';

/**
 * Build the top-level help. `fortress-csip`, `fortress-csip help`, and `fortress-csip --help`
 * all render this exact text, so the three cannot drift apart.
 */
export function topLevelHelp(commands: readonly Command[]): string {
  const width = Math.max(...commands.map((command) => nameColumn(command).length));
  const lines = [
    'Fortress CSIP Partner Toolkit',
    '',
    ...INTEGRATION_MODEL,
    '',
    'Typical journey:',
    `  ${JOURNEY}`,
    '',
    'Commands:',
    ...commands.map(
      (command) => `  ${nameColumn(command).padEnd(width + 2)}${command.summary}`,
    ),
    '',
    'Run `fortress-csip <command> --help` for command-specific help.',
  ];
  return lines.join('\n');
}

function nameColumn(command: Command): string {
  return command.arguments.length > 0 ? `${command.name} ${command.arguments}` : command.name;
}

/**
 * Shared tail for command help: where the output goes and what it will never contain.
 * Repeated verbatim under every checking command so a partner reading one page sees it.
 */
export const REPORT_HELP = [
  'Output:',
  '  --json                 Write the report to stdout as JSON and nothing else',
  '  --out PATH             Write the report atomically to PATH',
  '',
  'Reports never contain PEM bodies, private keys, raw XML, response headers,',
  'device serials, or environment dumps. They carry check IDs, bounded messages,',
  'the origin you supplied, and your certificate LFDI, fingerprint, and expiry.',
];

/** Shared tail for command help: what each exit code means. */
export const EXIT_CODE_HELP = [
  'Exit codes:',
  '  0  checks passed',
  '  1  the command ran, but one or more checks failed',
  '  2  invalid arguments or configuration',
  '  3  the toolkit or its environment failed (missing Docker, unreadable file)',
];
