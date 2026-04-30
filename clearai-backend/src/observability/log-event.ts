import { getPool } from '../db/client.js';
import type { LlmStatus } from '../llm/client.js';
import type {
  DecisionStatus,
  DecisionReason,
  ConfidenceBand,
} from '../types/domain.js';

/**
 * Minimal structural type compatible with Fastify's `req.log` (and any
 * pino-style logger). Keeps log-event.ts free of a Fastify dependency
 * while letting routes hand in a real request-scoped logger.
 */
export interface LogEventLogger {
  error(obj: unknown, msg?: string): void;
}

export interface EventInsert {
  // Persisted endpoint enum. Stays as 'describe' / 'expand' even after the
  // 2026 URL refactor (POST /classifications, POST /classifications/expand)
  // so trace queries don't need a UNION across old and new names. The 'boost'
  // value is gone — old rows keep their value for historical lookups.
  endpoint: 'describe' | 'expand';
  request: unknown;
  languageDetected: string | null;
  decisionStatus: DecisionStatus;
  decisionReason: DecisionReason;
  confidenceBand: ConfidenceBand | null;
  chosenCode: string | null;
  alternatives: unknown;
  topRetrievalScore: number | null;
  top2Gap: number | null;
  candidateCount: number | null;
  branchSize: number | null;
  llmUsed: boolean;
  llmStatus: LlmStatus | null;
  guardTripped: boolean;
  modelCalls: unknown;
  embedderVersion: string;
  llmModel: string | null;
  totalLatencyMs: number;
  error: string | null;
  /**
   * Picker's plain-English explanation of *why* this code was chosen.
   * Surfaced on /trace/:eventId so trace-replay is as informative as the
   * original response. Null on paths that don't produce one — best-effort
   * fallback, degraded, gate-failed-no-llm.
   */
  rationale: string | null;
}

/**
 * Insert one classification event row and return the auto-generated UUID
 * primary key. The id is surfaced on the response (`request_id`) so the
 * frontend can deep-link to /trace/:id and POST feedback against the same
 * row. Returning null instead of throwing on DB failure means logging is
 * best-effort — we never break a successful classification because logging
 * happened to fail.
 *
 * Pass `req.log` from a Fastify handler as the second argument so failures
 * land in the structured request log (with request id correlation). When
 * omitted (e.g. ErrorHandler outside the route context) we fall back to
 * `console.error` — still better than swallowing the failure.
 */
export async function logEvent(
  e: EventInsert,
  logger?: LogEventLogger,
): Promise<string | null> {
  const pool = getPool();
  try {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO classification_events (
      endpoint, request, language_detected,
      decision_status, decision_reason, confidence_band,
      chosen_code, alternatives,
      top_retrieval_score, top2_gap, candidate_count, branch_size,
      llm_used, llm_status, guard_tripped,
      model_calls, embedder_version, llm_model, total_latency_ms, error,
      rationale
    ) VALUES (
      $1, $2, $3,
      $4, $5, $6,
      $7, $8,
      $9, $10, $11, $12,
      $13, $14, $15,
      $16, $17, $18, $19, $20,
      $21
    ) RETURNING id`,
      [
        e.endpoint,
        JSON.stringify(e.request),
        e.languageDetected,
        e.decisionStatus,
        e.decisionReason,
        e.confidenceBand,
        e.chosenCode,
        e.alternatives === null ? null : JSON.stringify(e.alternatives),
        e.topRetrievalScore,
        e.top2Gap,
        e.candidateCount,
        e.branchSize,
        e.llmUsed,
        e.llmStatus,
        e.guardTripped,
        e.modelCalls === null ? null : JSON.stringify(e.modelCalls),
        e.embedderVersion,
        e.llmModel,
        e.totalLatencyMs,
        e.error,
        e.rationale,
      ],
    );
    return r.rows[0]?.id ?? null;
  } catch (err) {
    if (logger) {
      logger.error({ err, endpoint: e.endpoint }, '[logEvent] insert failed');
    } else {
      // eslint-disable-next-line no-console
      console.error('[logEvent] insert failed:', err);
    }
    return null;
  }
}
