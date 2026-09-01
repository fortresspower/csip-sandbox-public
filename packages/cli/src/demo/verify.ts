import type { Io } from '../io.js';

/**
 * Deterministic verification of the demo's closed loop.
 *
 * This is the assertion `scripts/demo-loop.sh` made — dispatch a bounded fixed-W command and
 * prove telemetry moves in response — with the fixed sleeps replaced by polling to a deadline.
 * Blind sleeps make the check flaky on a slow machine and slow on a fast one; polling makes it
 * both faster and more reliable without changing what is being proven.
 */

export const CONSOLE_URL = 'http://localhost:7001/';
export const SWAGGER_URL = 'http://localhost:7001/docs';
export const CLIENT_STATUS_URL = 'http://localhost:7100/status';
const DISPATCH_URL = 'http://localhost:7001/test/dercontrol';

/** Watts commanded during verification. Negative is charge, per the control sign convention. */
const VERIFY_WATTS = -3000;

export interface VerifyOptions {
  fetch: typeof globalThis.fetch;
  io: Io;
  /** How long to wait for the stack to answer at all. */
  readyTimeoutMs?: number;
  /** How long to wait for telemetry to reflect the dispatch. */
  settleTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Injected for tests; real runs use a timer. */
  sleep?: (ms: number) => Promise<void>;
}

export interface VerifyOutcome {
  passed: boolean;
  detail: string;
  realPowerBefore?: number;
  realPowerAfter?: number;
}

export async function verifyDemoLoop(options: VerifyOptions): Promise<VerifyOutcome> {
  const {
    fetch,
    io,
    readyTimeoutMs = 120_000,
    settleTimeoutMs = 60_000,
    pollIntervalMs = 1_000,
    sleep = defaultSleep,
  } = options;

  const start = io.now().getTime();
  const deadline = (budget: number) => start + budget;

  io.out('Waiting for the stack to come up...');
  const baseline = await pollForPower(
    fetch,
    io,
    sleep,
    pollIntervalMs,
    deadline(readyTimeoutMs),
    () => true,
  );
  if (baseline === undefined) {
    return { passed: false, detail: 'the client never reported telemetry before the deadline' };
  }
  io.out(`Before dispatch: realPowerW = ${baseline}`);

  const mrid = `DEMO-VERIFY-${io.now().getTime()}`;
  const dispatch = await fetch(DISPATCH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mRID: mrid, opModFixedW: VERIFY_WATTS }),
  });
  if (!dispatch.ok) {
    return { passed: false, detail: `dispatch was rejected with HTTP ${dispatch.status}` };
  }
  io.out(`Dispatched opModFixedW=${VERIFY_WATTS} as ${mrid}`);

  const settleStart = io.now().getTime();
  const after = await pollForPower(
    fetch,
    io,
    sleep,
    pollIntervalMs,
    settleStart + settleTimeoutMs,
    (value) => value < 0,
  );

  if (after === undefined || after >= 0) {
    return {
      passed: false,
      detail:
        'telemetry did not move to charging within the deadline — ' +
        'the client polled the control but reported no change',
      realPowerBefore: baseline,
      realPowerAfter: after,
    };
  }

  io.out(`After dispatch:  realPowerW = ${after}`);
  return {
    passed: true,
    detail: 'dispatch moved telemetry',
    realPowerBefore: baseline,
    realPowerAfter: after,
  };
}

/**
 * Poll the client's status until `accept` holds for the reported power, or the budget runs out.
 *
 * Bounded by both a wall-clock deadline and an attempt count. The attempt count is not
 * redundant: a stopped clock — an injected one in a test, a suspended VM in the field — would
 * otherwise turn this into an infinite loop against a live endpoint.
 */
async function pollForPower(
  fetch: typeof globalThis.fetch,
  io: Io,
  sleep: (ms: number) => Promise<void>,
  intervalMs: number,
  deadlineMs: number,
  accept: (value: number) => boolean,
): Promise<number | undefined> {
  const budgetMs = Math.max(0, deadlineMs - io.now().getTime());
  const maxAttempts = Math.max(1, Math.ceil(budgetMs / Math.max(1, intervalMs)) + 1);
  let last: number | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const value = await readRealPower(fetch);
    if (value !== undefined) {
      last = value;
      if (accept(value)) return value;
    }
    if (io.now().getTime() >= deadlineMs) break;
    await sleep(intervalMs);
  }
  return last;
}

async function readRealPower(fetch: typeof globalThis.fetch): Promise<number | undefined> {
  try {
    const response = await fetch(CLIENT_STATUS_URL);
    if (!response.ok) return undefined;
    const body = (await response.json()) as { snapshot?: { realPowerW?: unknown } };
    const value = body.snapshot?.realPowerW;
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  } catch {
    // The stack is still starting, or has just been torn down. Not a failure on its own —
    // the deadline decides.
    return undefined;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
