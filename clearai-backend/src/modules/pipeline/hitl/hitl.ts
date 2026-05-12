/**
 * HITL queue writer. Caller must run this AFTER the
 * classification_events row exists — hitl_queue.classification_event_id
 * has an FK to it.
 */
import { getPool } from '../../../db/client.js';
import { newId } from '../../../common/utils/uuid.js';
import type { StageVerdictOutput, SanityResult } from '../shared/pipeline.types.js';

interface PipelineEventLogger {
  error(obj: unknown, msg?: string): void;
}

export interface HitlPayload {
  classification_event_id: string;
  item_id: string;
  /**
   * Parent batch id. NULL for single-shot dispatches (no batch context).
   * Set for batch-sourced reviews. Added in migration 0075.
   */
  batch_id: string | null;
  operator_slug: string;
  reason: 'verdict_escalate' | 'sanity_flag' | 'low_information';
  cleaned_description: string;
  verdict_output: StageVerdictOutput | null;
  sanity_result: SanityResult | null;
  trace: unknown;
  enqueued_at: string;
}

// Best-effort: a queue write failure must not abort the dispatch response.
export async function enqueueHitl(
  payload: HitlPayload,
  logger?: PipelineEventLogger,
): Promise<void> {
  const pool = getPool();
  try {
    await pool.query(
      `INSERT INTO hitl_queue (
        id,
        enqueued_at,
        classification_event_id,
        item_id,
        batch_id,
        operator_slug,
        reason,
        payload
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        newId(),
        payload.enqueued_at,
        payload.classification_event_id,
        payload.item_id,
        payload.batch_id,
        payload.operator_slug,
        payload.reason,
        JSON.stringify({
          cleaned_description: payload.cleaned_description,
          verdict_output: payload.verdict_output,
          sanity_result: payload.sanity_result,
          trace: payload.trace,
        }),
      ],
    );
  } catch (err) {
    if (logger) {
      logger.error({ err, item_id: payload.item_id }, '[hitl_queue] insert failed');
    } else {
      // eslint-disable-next-line no-console
      console.error('[hitl_queue] insert failed:', err);
    }
  }
}

export function shouldEnqueue(
  verdictOutput: StageVerdictOutput | null,
  sanityResult: SanityResult | null,
): boolean {
  if (!verdictOutput || verdictOutput.decision === 'escalate') return true;
  if (sanityResult?.verdict === 'FLAG') return true;
  return false;
}
