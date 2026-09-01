import { spawn } from 'node:child_process';

/**
 * Child-process seam.
 *
 * Docker is the one external program the toolkit drives. Tests substitute this so the demo
 * command's argument construction, failure mapping, and teardown ordering can be asserted on
 * a machine with no Docker daemon.
 */

export interface ProcessRequest {
  /** Executable name. Never a shell string — arguments are passed as a vector. */
  command: string;
  args: string[];
  cwd: string;
  /** Forward child output to the parent's stdio instead of capturing it. */
  inherit?: boolean;
  /** Fail the call if the child has not exited within this many milliseconds. */
  timeoutMs?: number;
  /** Cap on captured output, so a runaway child cannot exhaust memory. */
  maxOutputBytes?: number;
}

export interface ProcessResult {
  /** Exit status, or null when the child was terminated by a signal. */
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Empty when `inherit` was set. Truncated at `maxOutputBytes`. */
  stdout: string;
  stderr: string;
}

export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;

const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

export const runNodeProcess: ProcessRunner = (request) =>
  new Promise((resolve, reject) => {
    const limit = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      stdio: request.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      // No shell: partner-supplied strings never reach a shell parser.
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    const collect = (into: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (into === 'stdout') stdout = truncate(stdout + text, limit);
      else stderr = truncate(stderr + text, limit);
    };
    child.stdout?.on('data', collect('stdout'));
    child.stderr?.on('data', collect('stderr'));

    const timer =
      request.timeoutMs === undefined
        ? undefined
        : setTimeout(() => child.kill('SIGKILL'), request.timeoutMs);

    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit);
}
