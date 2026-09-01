import type { ProcessRunner } from '../adapters/process.js';
import { OperationalError } from '../errors.js';

/**
 * Docker Compose driver for the local demo.
 *
 * The compose topology itself is unchanged — this drives `docker-compose.yml` exactly as
 * `docker compose up` would. What it adds is a readable failure when Docker is missing or
 * not running, which is the single most common first-five-minutes failure for a partner, and
 * one that a raw ENOENT does not explain.
 */

export interface DockerDriver {
  /** Confirm Docker and the compose plugin are usable. Throws OperationalError otherwise. */
  preflight(): Promise<void>;
  /** `docker compose up --build`, detached. */
  up(): Promise<void>;
  /** `docker compose up --build` in the foreground, forwarding output. Returns Docker's code. */
  upAttached(): Promise<number>;
  /** `docker compose down`. Never throws: teardown runs on the failure path too. */
  down(): Promise<void>;
}

const PREFLIGHT_TIMEOUT_MS = 30_000;
const UP_TIMEOUT_MS = 10 * 60_000;
const DOWN_TIMEOUT_MS = 2 * 60_000;

export function createDockerDriver(runProcess: ProcessRunner, cwd: string): DockerDriver {
  const compose = (args: string[], options: { inherit?: boolean; timeoutMs: number }) =>
    runProcess({ command: 'docker', args: ['compose', ...args], cwd, ...options });

  return {
    async preflight(): Promise<void> {
      let version;
      try {
        version = await runProcess({
          command: 'docker',
          args: ['compose', 'version'],
          cwd,
          timeoutMs: PREFLIGHT_TIMEOUT_MS,
        });
      } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') {
          throw new OperationalError(
            'docker was not found on PATH',
            'Install Docker Desktop or the Docker Engine, then re-run. ' +
              'See the README for the equivalent manual `docker compose up` steps.',
          );
        }
        throw new OperationalError(`could not run docker: ${(error as Error).message}`);
      }
      if (version.code !== 0) {
        // Exit status here means Docker exists but compose is unavailable or the daemon is
        // not reachable. Its own stderr says which, and it is safe to surface: it is a local
        // tool message, not partner data.
        throw new OperationalError(
          'docker is installed but `docker compose` is not usable',
          firstLine(version.stderr) ??
            'Start the Docker daemon, or install the Compose plugin (docker compose v2).',
        );
      }
    },

    async up(): Promise<void> {
      const result = await compose(['up', '--build', '-d'], { timeoutMs: UP_TIMEOUT_MS });
      if (result.code !== 0) {
        throw new OperationalError(
          `docker compose up failed (exit ${result.code ?? 'signal'})`,
          firstLine(result.stderr) ?? 'Run `docker compose up --build` to see the full output.',
        );
      }
    },

    async upAttached(): Promise<number> {
      const result = await compose(['up', '--build'], { inherit: true, timeoutMs: UP_TIMEOUT_MS });
      // Docker's own status is the command's status: a partner debugging a failing stack
      // needs the code Docker actually returned, not one this wrapper invented.
      return result.code ?? 1;
    },

    async down(): Promise<void> {
      try {
        await compose(['down'], { timeoutMs: DOWN_TIMEOUT_MS });
      } catch {
        // Teardown is best-effort by design. It runs from the failure path and from signal
        // handlers, where throwing would mask the original failure or hang the exit.
      }
    },
  };
}

function firstLine(text: string): string | undefined {
  const line = text.split('\n').map((entry) => entry.trim()).find((entry) => entry.length > 0);
  return line === undefined ? undefined : line.slice(0, 300);
}
