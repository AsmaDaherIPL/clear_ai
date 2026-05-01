import { getPool } from '../db/client.js';
import type { LlmStatus } from '../llm/client.js';
import type {
  DecisionStatus,
  DecisionReason,
  ConfidenceBand,
} from '../types/domain.js';

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

/** Insert one classification event row and return its UUID, or null on DB failure. */
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
