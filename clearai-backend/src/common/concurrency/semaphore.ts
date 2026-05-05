/**
 * In-process concurrency limiter. Used by Phase 1 of the batch pipeline to
 * cap concurrent dispatch() calls per batch (Foundry has no Anthropic Batch
 * API; concurrency is the only throughput lever).
 *
 * Backed by p-limit. The factory takes a positive integer limit and returns
 * a wrapper:
 *
 *   const run = withSemaphore(env.BATCH_LLM_CONCURRENCY);
 *   await Promise.all(items.map((it) => run(() => dispatch(it))));
 *
 * Errors propagate through unchanged. The limiter holds no state beyond the
 * p-limit instance — no global registry; per-batch instances are fine.
 */
import pLimit from 'p-limit';

export type SemaphoreRunner = <T>(fn: () => Promise<T>) => Promise<T>;

export function withSemaphore(limit: number): SemaphoreRunner {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`withSemaphore: limit must be a positive integer, got ${limit}`);
  }
  const lim = pLimit(limit);
  return <T>(fn: () => Promise<T>): Promise<T> => lim(fn);
}
