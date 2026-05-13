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
}

const INSERT_SQL = `
  INSERT INTO llm_call_metrics
    (stage, model, attempt, outcome_class, latency_ms, http_status, error_class)
  VALUES
    ($1, $2, $3, $4, $5, $6, $7)
`;

export async function writeLlmCallMetric(input: LlmCallMetricInput): Promise<void> {
  // Gate: metrics inserts require migration 0078 (the table itself). When
  // 0078 hasn't been applied yet the env flag stays off and we skip the
  // INSERT entirely — otherwise every LLM call would log a table-missing
  // warning. Flip LLM_CALL_METRICS_ENABLED=true after the migration runs.
  if (!env().LLM_CALL_METRICS_ENABLED) return;
  await getPool().query(INSERT_SQL, [
    input.stage,
    input.model,
    input.attempt,
    input.outcomeClass,
    input.latencyMs,
    input.httpStatus,
    input.errorClass,
  ]);
}
