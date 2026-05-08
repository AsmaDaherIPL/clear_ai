/**
 * HITL queue — Human-in-the-loop escalation.
 *
 * Wired to the hitl_queue table (added in 0060). The orchestrator surfaces
 * its HITL intent on PipelineResult.hitl; the dispatch route calls
 * enqueueHitl() AFTER the classification_events row has been written, so
 * the FK from hitl_queue.classification_event_id is always satisfied.
 *
 * Items enqueued here still ship back to the caller with sanity_verdict
 * 'FLAG' and status 'flagged' — they're additionally surfaced in the
 * review queue.
 *
 * v0 access policy: rows are filtered by operator_slug at the app layer.
 * Any logged-in user with access to operator X sees X's pending items.
 * No claim/assignment semantics yet.
 */
import { getPool } from '../../../db/client.js';
import { newId } from '../../../common/utils/uuid.js';
import type { StageVerdictOutput, SanityResult } from '../shared/pipeline.types.js';

interface PipelineEventLogger {
  error(obj: unknown, msg?: string): void;
}

export interface HitlPayload {
  /** UUID of the classification_events row this review points to. */
  classification_event_id: string;
  item_id: string;
  operator_slug: string;
  reason: 'verdict_escalate' | 'sanity_flag';
  cleaned_description: string;
  verdict_output: StageVerdictOutput | null;
  sanity_result: SanityResult | null;
  /** Full DispatchV1Trace serialised as jsonb. */
  trace: unknown;
  enqueued_at: string;
}

/**
 * Insert one hitl_queue row. Best-effort: a queue write failure logs but
 * never throws — the dispatch response has already been built.
 */
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
        operator_slug,
        reason,
        payload
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        newId(),
        payload.enqueued_at,
        payload.classification_event_id,
        payload.item_id,
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
  // sanity LLM only returns PASS | FLAG; BLOCK on PipelineResult is reserved
  // for pre-classification rejections that the orchestrator emits before
  // sanity runs and never produces a SanityResult for.
  if (sanityResult?.verdict === 'FLAG') return true;
  return false;
}
