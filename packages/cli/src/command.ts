import type { ExitCode } from './errors.js';
import type { Io } from './io.js';
import type { ProcessRunner } from './adapters/process.js';
import type { HostResolver } from './adapters/dns.js';

/**
 * Everything a command is allowed to reach outside its own module.
 *
 * Handlers take this rather than importing `node:child_process` or `node:dns` directly, so a
 * test can run the real command logic with a fake Docker, a fake resolver, and an in-memory
 * console. Each adapter documents which commands use it.
 */
export interface CommandContext {
  io: Io;
  /** Spawns child processes. Used by `demo` to drive Docker Compose. */
  runProcess: ProcessRunner;
  /** Resolves hostnames to addresses. Used by `doctor` to enforce deployed DNS rules. */
  resolveHost: HostResolver;
  /**
   * Plain HTTP client, used only against the local demo stack on loopback. Partner-endpoint
   * traffic goes through client-core's transport instead, which enforces the deployed TLS,
   * DNS, redirect, and size rules that this does not.
   */
  fetch: typeof globalThis.fetch;
  /**
   * Delay between polls. Injected so that tests exercising the real polling loops finish in
   * test time; a fake clock alone is not enough, because the delay itself is real.
   */
  sleep: (ms: number) => Promise<void>;
  /** Absolute path of the repository checkout the CLI was launched from. */
  repositoryRoot: string;
}

export interface Command {
  /** Invocation name, as typed. */
  readonly name: string;
  /** Argument shape shown in the command table, e.g. `<origin> [options]`. */
  readonly arguments: string;
  /** One line for the top-level command table. Keep it under about 60 characters. */
  readonly summary: string;
  /** Full `fortress-csip <name> --help` text, already wrapped. */
  help(): string;
  /** Run with the arguments that follow the command name. */
  run(argv: string[], context: CommandContext): Promise<ExitCode>;
}
