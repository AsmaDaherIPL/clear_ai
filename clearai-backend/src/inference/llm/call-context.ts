/**
 * Async-local context for LLM call bookkeeping.
 *
 * The orchestrator runs hundreds of LLM calls per row across many
 * stages. Each call needs to know which batch it belongs to so the
 * `llm_call_metrics.batch_id` column can be populated. Threading the
 * batch_id through every stage signature (parse → identify → merchant
 * → scope → retrieve → pick → verify → sanity → submission) would
 * touch every file in the pipeline.
 *
 * AsyncLocalStorage solves this without signature pollution: the
 * orchestrator entry calls `runWithLlmCallContext({ batchId }, fn)`
 * once, and `metrics.ts` reads the current context when building each
 * INSERT. Pipeline modules in between need no changes.
 *
 * If `getCurrentLlmCallContext()` is called outside a `runWith…`
 * scope (e.g. ad-hoc scripts, unit tests) it returns `null` and
 * metric inserts fall back to `batch_id = null` — same behaviour as
 * before this file existed.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface LlmCallContext {
  /** Owning batch row when the LLM call was triggered by a batch dispatch. */
  batchId: string | null;
}

const storage = new AsyncLocalStorage<LlmCallContext>();

/**
 * Run `fn` inside a context that LLM metric writers can read via
 * `getCurrentLlmCallContext()`. Nested calls overwrite the context for
 * their inner scope only (standard AsyncLocalStorage semantics).
 */
export function runWithLlmCallContext<T>(ctx: LlmCallContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

/** Read the active context. Returns null when not inside a `runWith…` scope. */
export function getCurrentLlmCallContext(): LlmCallContext | null {
  return storage.getStore() ?? null;
}
