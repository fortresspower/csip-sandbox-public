import { parseArgs, type ParseArgsConfig } from 'node:util';
import { UsageError } from './errors.js';

/**
 * Thin wrapper over Node's built-in `parseArgs`.
 *
 * Node covers the whole surface the contract needs — long options, booleans, string values,
 * positionals — so the toolkit takes no argument-parsing dependency. This wrapper exists only
 * to turn `parseArgs`'s throw into a `UsageError` carrying the command name, so the wrapper
 * can point the partner at the right `--help`.
 */
export function parseCommandArgs<T extends NonNullable<ParseArgsConfig['options']>>(
  command: string,
  argv: string[],
  options: T,
): { values: Record<string, string | boolean | undefined>; positionals: string[] } {
  try {
    const parsed = parseArgs({
      args: argv,
      options: { ...options, help: { type: 'boolean' } },
      allowPositionals: true,
      strict: true,
    });
    return {
      values: parsed.values as Record<string, string | boolean | undefined>,
      positionals: parsed.positionals,
    };
  } catch (error) {
    throw new UsageError(unknownOptionMessage(error), command);
  }
}

function unknownOptionMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Node's messages already name the offending option; strip its trailing hint about
  // `allowPositionals`, which is an implementation detail of this wrapper.
  return message.split('\n')[0].trim();
}

/** Read an option that must be a string when present. */
export function stringOption(
  values: Record<string, string | boolean | undefined>,
  name: string,
  command: string,
): string | undefined {
  const value = values[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new UsageError(`--${name} requires a value`, command);
  }
  return value;
}

/** Read a boolean flag. Absent means false. */
export function flag(
  values: Record<string, string | boolean | undefined>,
  name: string,
): boolean {
  return values[name] === true;
}

/** Require exactly `count` positionals, with a contract-shaped message when they are wrong. */
export function requirePositionals(
  positionals: string[],
  count: number,
  command: string,
  usage: string,
): string[] {
  if (positionals.length !== count) {
    const problem =
      positionals.length < count
        ? `${command} requires ${count} argument${count === 1 ? '' : 's'}`
        : `${command} takes ${count} argument${count === 1 ? '' : 's'}, got ${positionals.length}`;
    throw new UsageError(`${problem}\n  usage: fortress-csip ${usage}`, command);
  }
  return positionals;
}
