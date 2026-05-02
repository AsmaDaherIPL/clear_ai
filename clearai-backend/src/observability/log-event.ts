import { getPool } from '../db/client.js';
import type { LlmStatus } from '../llm/client.js';
import type {
  DecisionStatus,
  DecisionReason,
  ConfidenceBand,
} from '../types/domain.js';
import { redactRequestBody } from './redact.js';
import { newId } from '../util/uuid.js';

/** Pino-compatible logger shape (matches Fastify's `req.log`). */
export interface LogEventLogger {
  error(obj: unknown, msg?: string): void;
}

export interface EventInsert {
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
  /** Picker's plain-English reason for the chosen code. Null when no picker ran. */
  rationale: string | null;
}

/**
 * Insert one classification event row and return its UUID, or null on DB
 * failure.
 *
 * Phase 2.4 (PII redaction): we now write a `request_redacted` shadow copy
 * alongside the raw `request`. Storage layout:
 *   - request          — full audit (admin/migrator only via column GRANT)
 *   - request_redacted — phone/email/long-id/URL stripped to markers,
 *                        readable by every role including readonly
 *
 * The redactor is pure + cheap (regex-only, no DB, no LLM) so we run it
 * synchronously on the hot path. If it ever becomes a bottleneck we can
 * move it to a background queue and accept brief windows where redacted
 * is null — the column already nullable.
 */
export async function logEvent(
  e: EventInsert,
  logger?: LogEventLogger,
): Promise<string | null> {
  const pool = getPool();
  try {
    const redacted = redactRequestBody(e.request);
    // UUIDv7 generated in TS for time-ordered btree-friendly inserts
    // (see src/util/uuid.ts). The DB default gen_random_uuid() stays as
    // a safety net but should never fire in practice.
    const id = newId();
    const r = await pool.query<{ id: string }>(
      `INSERT INTO classification_events (
      id,
      endpoint, request, request_redacted, language_detected,
      decision_status, decision_reason, confidence_band,
      chosen_code, alternatives,
      top_retrieval_score, top2_gap, candidate_count, branch_size,
      llm_used, llm_status, guard_tripped,
      model_calls, embedder_version, llm_model, total_latency_ms, error,
      rationale
    ) VALUES (
      $1,
      $2, $3, $4, $5,
      $6, $7, $8,
      $9, $10,
      $11, $12, $13, $14,
      $15, $16, $17,
      $18, $19, $20, $21, $22,
      $23
    ) RETURNING id`,
      [
        id,
        e.endpoint,
        JSON.stringify(e.request),
        redacted === null ? null : JSON.stringify(redacted),
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
