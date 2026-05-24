/**
 * Fire-and-forget writer for `llm_call_metrics`.
 *
 * Imported only by inference/llm/client.ts:finalize(). All inserts are
 * best-effort — a failing write logs a console.warn and resolves; it never
 * throws back to the caller. Pooled `pg` client; no Drizzle, to keep this
 * path dependency-light and lazy.
 */
import { getPool } from '../../db/client.js';
import { env } from '../../config/env.js';
import type { LlmFailureClass } from './breaker.js';
import type { LlmStage } from './policy.js';
import type { LlmStatus } from '../../modules/pipeline/shared/domain.types.js';
import { getCurrentLlmCallContext } from './call-context.js';

export interface LlmCallMetricInput {
  stage: LlmStage;
  model: string;
  /** 1-based attempt index from callLlmWithRetry's loop. */
  attempt: number;
  outcomeClass: LlmFailureClass;
  latencyMs: number;
  httpStatus: number | null;
  /** Transport LlmStatus on non-ok results; null on success. */
  errorClass: LlmStatus | null;
  /** From Anthropic's usage.input_tokens; null when absent. */
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** Prompt-cache accounting (0093). Either is > 0 when caching engaged. */
  cacheCreationInputTokens?: number | null;
  cacheReadInputTokens?: number | null;
}

const INSERT_SQL = `
  INSERT INTO llm_call_metrics
    (stage, model, attempt, outcome_class, latency_ms, http_status, error_class,
     input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
     batch_id)
  VALUES
    ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
`;

export async function writeLlmCallMetric(input: LlmCallMetricInput): Promise<void> {
  // Gate: metrics inserts require migration 0078 (the table itself). When
  // 0078 hasn't been applied yet the env flag stays off and we skip the
  // INSERT entirely — otherwise every LLM call would log a table-missing
  // warning. Flip LLM_CALL_METRICS_ENABLED=true after the migration runs.
  if (!env().LLM_CALL_METRICS_ENABLED) return;
  // batch_id is read from the AsyncLocalStorage context set by the
  // orchestrator entry. NULL when the call wasn't dispatched from a
  // batch row (e.g. single-shot /classifications, ad-hoc scripts) —
  // same semantics as the column's nullable definition in 0093.
  const ctx = getCurrentLlmCallContext();
  await getPool().query(INSERT_SQL, [
    input.stage,
    input.model,
    input.attempt,
    input.outcomeClass,
    input.latencyMs,
    input.httpStatus,
    input.errorClass,
    input.inputTokens ?? null,
    input.outputTokens ?? null,
    input.cacheCreationInputTokens ?? null,
    input.cacheReadInputTokens ?? null,
    ctx?.batchId ?? null,
  ]);
}
