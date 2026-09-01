import { describe, expect, it } from 'vitest';
import type { ProcessRequest, ProcessResult, ProcessRunner } from '../src/adapters/process.js';
import { runCli } from '../src/cli.js';
import { createCommands } from '../src/commands/index.js';
import { EXIT_CHECKS_FAILED, EXIT_OK, EXIT_OPERATIONAL, EXIT_USAGE } from '../src/errors.js';
import { CLIENT_STATUS_URL } from '../src/demo/verify.js';
import { testContext } from './support/context.js';

/** A Docker that succeeds, recording every compose invocation in order. */
function fakeDocker(
  responses: Partial<Record<string, ProcessResult>> = {},
): { runner: ProcessRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: ProcessRunner = async (request: ProcessRequest) => {
    calls.push([request.command, ...request.args]);
    const key = request.args.join(' ');
    return responses[key] ?? { code: 0, signal: null, stdout: '', stderr: '' };
  };
  return { runner, calls };
}

/** An advancing clock, so polling loops terminate in test time rather than wall time. */
function advancingClock(stepMs = 5_000): () => Date {
  let current = Date.parse('2026-09-01T14:00:00.000Z');
  return () => {
    const now = new Date(current);
    current += stepMs;
    return now;
  };
}

async function demo(
  argv: string[],
  overrides: Parameters<typeof testContext>[0] = {},
): Promise<{ code: number; out: string; err: string }> {
  const { context, io } = testContext(overrides);
  const code = await runCli(['demo', ...argv], context, createCommands());
  return { code, out: io.stdout.join('\n'), err: io.stderr.join('\n') };
}

describe('demo preflight', () => {
  it('checks that docker compose is usable before starting anything', async () => {
    const { runner, calls } = fakeDocker();
    await demo(['--detach'], { runProcess: runner });
    expect(calls[0]).toEqual(['docker', 'compose', 'version']);
  });

  it('explains a missing docker rather than surfacing ENOENT', async () => {
    const runner: ProcessRunner = async () => {
      throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
    };
    const { code, err } = await demo(['--detach'], { runProcess: runner });
    expect(code).toBe(EXIT_OPERATIONAL);
    expect(err).toContain('docker was not found on PATH');
    expect(err).toContain('Install Docker');
  });

  it('explains a present docker with an unusable compose plugin', async () => {
    const { runner } = fakeDocker({
      'compose version': { code: 1, signal: null, stdout: '', stderr: 'daemon not running\n' },
    });
    const { code, err } = await demo(['--detach'], { runProcess: runner });
    expect(code).toBe(EXIT_OPERATIONAL);
    expect(err).toContain('`docker compose` is not usable');
    expect(err).toContain('daemon not running');
  });

  it('does not start the stack when preflight fails', async () => {
    const { runner, calls } = fakeDocker({
      'compose version': { code: 1, signal: null, stdout: '', stderr: 'nope\n' },
    });
    await demo(['--detach'], { runProcess: runner });
    expect(calls.map((call) => call.join(' '))).toEqual(['docker compose version']);
  });
});

describe('demo topology', () => {
  it('starts the existing compose stack unchanged and prints the URLs', async () => {
    const { runner, calls } = fakeDocker();
    const { code, out } = await demo(['--detach'], { runProcess: runner });
    expect(code).toBe(EXIT_OK);
    expect(calls[1]).toEqual(['docker', 'compose', 'up', '--build', '-d']);
    expect(out).toContain('http://localhost:7001/');
    expect(out).toContain('http://localhost:7001/docs');
    expect(out).toContain(CLIENT_STATUS_URL);
  });

  it('runs in the repository checkout, not the working directory', async () => {
    const seen: string[] = [];
    const runner: ProcessRunner = async (request) => {
      seen.push(request.cwd);
      return { code: 0, signal: null, stdout: '', stderr: '' };
    };
    const { context } = testContext({ runProcess: runner, repositoryRoot: '/checkout' });
    await runCli(['demo', '--detach'], context, createCommands());
    expect(new Set(seen)).toEqual(new Set(['/checkout']));
  });

  it('passes arguments as a vector, never through a shell', async () => {
    const requests: ProcessRequest[] = [];
    const runner: ProcessRunner = async (request) => {
      requests.push(request);
      return { code: 0, signal: null, stdout: '', stderr: '' };
    };
    await demo(['--detach'], { runProcess: runner });
    for (const request of requests) {
      expect(request.command).toBe('docker');
      expect(request.args.every((argument) => !argument.includes(' '))).toBe(true);
    }
  });

  it('returns a failure status when compose cannot bring the stack up', async () => {
    const { runner } = fakeDocker({
      'compose up --build -d': { code: 1, signal: null, stdout: '', stderr: 'port in use\n' },
    });
    const { code, err } = await demo(['--detach'], { runProcess: runner });
    expect(code).toBe(EXIT_OPERATIONAL);
    expect(err).toContain('port in use');
  });

  it('rejects --detach with --verify', async () => {
    const { runner } = fakeDocker();
    const { code, err } = await demo(['--detach', '--verify'], { runProcess: runner });
    expect(code).toBe(EXIT_USAGE);
    expect(err).toContain('mutually exclusive');
  });

  it('rejects an unknown option', async () => {
    const { code, err } = await demo(['--turbo']);
    expect(code).toBe(EXIT_USAGE);
    expect(err).toContain('--turbo');
  });
});

describe('demo --verify', () => {
  /** A stack whose reported power flips negative once a control has been dispatched. */
  function fakeStack(options: { dispatchStatus?: number; settles?: boolean } = {}) {
    let dispatched = false;
    const posted: unknown[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith('/test/dercontrol')) {
        dispatched = true;
        posted.push(JSON.parse(String(init?.body)));
        const status = options.dispatchStatus ?? 202;
        return new Response(null, { status });
      }
      const realPowerW = dispatched && options.settles !== false ? -2950 : 1200;
      return Response.json({ snapshot: { realPowerW } });
    }) as unknown as typeof globalThis.fetch;
    return { fetch: fetchImpl, posted };
  }

  it('passes when dispatch moves telemetry, and tears the stack down', async () => {
    const { runner, calls } = fakeDocker();
    const stack = fakeStack();
    const { code, out } = await demo(['--verify'], {
      runProcess: runner,
      fetch: stack.fetch,
      io: { now: advancingClock() },
    });
    expect(code).toBe(EXIT_OK);
    expect(out).toContain('PASS');
    expect(calls.at(-1)).toEqual(['docker', 'compose', 'down']);
  });

  it('dispatches a bounded charge command with a unique mRID', async () => {
    const { runner } = fakeDocker();
    const stack = fakeStack();
    await demo(['--verify'], {
      runProcess: runner,
      fetch: stack.fetch,
      io: { now: advancingClock() },
    });
    expect(stack.posted).toHaveLength(1);
    expect(stack.posted[0]).toMatchObject({ opModFixedW: -3000 });
    expect((stack.posted[0] as { mRID: string }).mRID).toMatch(/^DEMO-VERIFY-\d+$/);
  });

  it('fails the check, not the command, when telemetry never moves', async () => {
    const { runner, calls } = fakeDocker();
    const stack = fakeStack({ settles: false });
    const { code, out } = await demo(['--verify'], {
      runProcess: runner,
      fetch: stack.fetch,
      io: { now: advancingClock() },
    });
    expect(code).toBe(EXIT_CHECKS_FAILED);
    expect(out).toContain('FAIL');
    expect(calls.at(-1)).toEqual(['docker', 'compose', 'down']);
  });

  it('tears down even when the dispatch is rejected', async () => {
    const { runner, calls } = fakeDocker();
    const stack = fakeStack({ dispatchStatus: 400 });
    const { code } = await demo(['--verify'], {
      runProcess: runner,
      fetch: stack.fetch,
      io: { now: advancingClock() },
    });
    expect(code).toBe(EXIT_CHECKS_FAILED);
    expect(calls.at(-1)).toEqual(['docker', 'compose', 'down']);
  });

  it('tears down even when the stack never answers', async () => {
    const { runner, calls } = fakeDocker();
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;
    const { code, out } = await demo(['--verify'], {
      runProcess: runner,
      fetch: fetchImpl,
      io: { now: advancingClock(30_000) },
    });
    expect(code).toBe(EXIT_CHECKS_FAILED);
    expect(out).toContain('never reported telemetry');
    expect(calls.at(-1)).toEqual(['docker', 'compose', 'down']);
  });

  it('tears down when verification throws unexpectedly', async () => {
    const { runner, calls } = fakeDocker();
    const fetchImpl = (() => {
      throw new TypeError('bad fetch');
    }) as unknown as typeof globalThis.fetch;
    await demo(['--verify'], {
      runProcess: runner,
      fetch: fetchImpl,
      io: { now: advancingClock() },
    });
    expect(calls.at(-1)).toEqual(['docker', 'compose', 'down']);
  });
});
