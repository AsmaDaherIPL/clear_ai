import { getPool } from '../db/client.js';
import type {
  DecisionStatus,
  DecisionReason,
  ConfidenceBand,
} from './types.js';

export interface EventInsert {
  endpoint: 'describe' | 'expand' | 'boost';
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
  llmStatus: 'ok' | 'error' | 'timeout' | null;
  guardTripped: boolean;
  modelCalls: unknown;
  embedderVersion: string;
  llmModel: string | null;
  totalLatencyMs: number;
  error: string | null;
}

export async function logEvent(e: EventInsert): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO classification_events (
      endpoint, request, language_detected,
      decision_status, decision_reason, confidence_band,
      chosen_code, alternatives,
      top_retrieval_score, top2_gap, candidate_count, branch_size,
      llm_used, llm_status, guard_tripped,
      model_calls, embedder_version, llm_model, total_latency_ms, error
    ) VALUES (
      $1, $2, $3,
      $4, $5, $6,
      $7, $8,
      $9, $10, $11, $12,
      $13, $14, $15,
      $16, $17, $18, $19, $20
    )`,
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
    ]
  );
}
