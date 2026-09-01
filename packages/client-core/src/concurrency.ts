export const DEFAULT_WORK_CONCURRENCY = 8;
export const MAX_WORK_CONCURRENCY = 8;

export interface CsipWorkOptions {
  /** Stops new work from being scheduled. Already-started transport calls are allowed to settle. */
  signal?: AbortSignal;
}

export function validateWorkConcurrency(value: number, label = 'concurrency'): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_WORK_CONCURRENCY) {
    throw new Error(`${label} must be a positive safe integer no greater than ${MAX_WORK_CONCURRENCY}`);
  }
  return value;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error('CSIP work was aborted');
}

/** Maps an in-memory work set without ever starting more than `concurrency` effects. */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let cursor = 0;
  let stopped = false;
  let firstError: unknown;
  const worker = async (): Promise<void> => {
    while (!stopped) {
      try {
        throwIfAborted(signal);
      } catch (error) {
        stopped = true;
        firstError ??= error;
        return;
      }
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = await mapper(items[index], index);
      } catch (error) {
        stopped = true;
        firstError ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  if (firstError !== undefined) throw firstError;
  return results;
}
