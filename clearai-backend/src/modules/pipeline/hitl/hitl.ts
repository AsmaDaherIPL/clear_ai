/**
 * HITL queue — Human-in-the-loop escalation.
 *
 * v0 policy: any item where Stage 2 escalates or Stage 3 returns FLAG is
 * enqueued here. The queue is a simple DB insert; a future worker reads it.
 *
 * Items enqueued here still progress to the declaration phase as 'flagged'
 * status — they are included in Phase 2 but marked for human review.
 */
import type { StageVerdictOutput, SanityResult, PipelineTrace } from '../shared/pipeline.types.js';

export interface HitlPayload {
  item_id: string;
  operator_slug: string;
  cleaned_description: string;
  verdict_output: StageVerdictOutput | null;
  sanity_result: SanityResult | null;
  trace: PipelineTrace;
  enqueued_at: string;
}

/**
 * Enqueue an item for human review.
 * v0: logs to console + returns the payload. A real DB-backed queue
 * implementation lands in the next sprint.
 */
export async function enqueueHitl(payload: HitlPayload): Promise<void> {
  // TODO(hitl-worker): replace with a DB insert into hitl_queue table.
  console.warn(
    `[HITL] item_id=${payload.item_id} operator=${payload.operator_slug} ` +
    `reason=${payload.sanity_result?.verdict ?? 'verdict_escalate'}`,
  );
}

export function shouldEnqueue(
  verdictOutput: StageVerdictOutput | null,
  sanityResult: SanityResult | null,
): boolean {
  if (!verdictOutput || verdictOutput.decision === 'escalate') return true;
  if (sanityResult?.verdict === 'FLAG' || sanityResult?.verdict === 'BLOCK') return true;
  return false;
}
