/**
 * Outcome categories for every `fortress-csip` invocation.
 *
 * These are deliberately distinct: a partner scripting the toolkit needs to tell "your server
 * failed a check" apart from "you typed the command wrong" apart from "Docker isn't running".
 * Only the executable wrapper turns these into a process exit code.
 */
export const EXIT_OK = 0;
/** The command ran correctly, but one or more readiness/conformance checks failed. */
export const EXIT_CHECKS_FAILED = 1;
/** Invalid arguments, unknown command, or a configuration combination the contract forbids. */
export const EXIT_USAGE = 2;
/** An unexpected operational failure: missing Docker, unreadable file, interrupted child. */
export const EXIT_OPERATIONAL = 3;

export type ExitCode =
  | typeof EXIT_OK
  | typeof EXIT_CHECKS_FAILED
  | typeof EXIT_USAGE
  | typeof EXIT_OPERATIONAL;

/** The partner asked for something the CLI contract does not accept. Their input is fixable. */
export class UsageError extends Error {
  /** Optional command name, so the wrapper can point at the right `--help`. */
  readonly command?: string;

  constructor(message: string, command?: string) {
    super(message);
    this.name = 'UsageError';
    this.command = command;
  }
}

/** The environment failed the CLI, not the partner's server. Not a check result. */
export class OperationalError extends Error {
  /** Short, bounded remediation shown under the error. */
  readonly remediation?: string;

  constructor(message: string, remediation?: string) {
    super(message);
    this.name = 'OperationalError';
    this.remediation = remediation;
  }
}

/**
 * Reduce any thrown value to a bounded, non-leaking message.
 *
 * Unexpected errors can carry response payloads, headers, or key material in their `cause`
 * chain or custom fields. Reports and terminal output take the message only, truncated.
 */
export function describeError(error: unknown, maxLength = 300): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'unexpected error';
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength - 1)}…` : collapsed;
}
