/**
 * Phase 1 — classification service.
 * Runs for every batch regardless of mode.
 *
 * Drives `dispatch(item)` per pending row under a p-limit semaphore
 * (BATCH_LLM_CONCURRENCY). NEVER touches XML, ZATCA, or blob storage.
 */
import { env } from '../../../config/env.js';
import { withSemaphore } from '../../../common/concurrency/semaphore.js';
import { isBreakerTripped, breakerStatus } from '../../../inference/llm/breaker.js';
import {
  listPendingItems,
  markClassificationPhase,
  markItemClassifying,
  recordItemResult,
} from './classification.repository.js';
import type {
  ClassificationOutcome,
  DispatchResult,
  ItemTrace,
  PhaseClassificationSummary,
  SanityVerdict,
} from './classification.types.js';
import type { CanonicalLineItem } from '../../operators/operator-config.types.js';
import type { DispatchFn } from '../../dispatch/dispatch.contract.ts';

export interface RunOptions {
  /**
   * Override the dispatch implementation. Phase 4 wires the real one
   * (modules/dispatch/dispatch.use-case.dispatch). Tests pass mocks.
   */
  dispatch: DispatchFn;
  /** Override the concurrency limit; default reads env(). */
  concurrency?: number;
}

function classifyOutcome(
  verdict: SanityVerdict,
  finalCode: string | null,
  infraDegraded: boolean,
  shortCircuit: boolean,
): ClassificationOutcome {
  // batch_items has a CHECK that final_code IS NOT NULL when
  // status IN ('succeeded','flagged'). Stage-2 escalate emits null
  // sanity verdict with no code; that row goes to 'failed' here. The
  // hitl_queue row is already written by dispatch.use-case so the
  // reviewer still sees it.
  //
  // The infraDegraded marker downgrades the natural outcome to
  // 'pending_infra' so the HITL queue can filter infra-only failures
  // (which usually resolve on a Foundry retry) separately from real
  // bad-data rows.
  //
  // Pre-classification short-circuit (parse rejection, unusable
  // cleanup): row goes to 'blocked' so operators can distinguish bad
  // input data from pipeline failures. infraDegraded does NOT override —
  // a short-circuited row is structurally unprocessable, not a transient
  // infra issue.
  if (shortCircuit) return 'blocked';
  // Other no-code paths (ZERO_SIGNAL escalate, picker_unavailable, etc.)
  // — pipeline started but couldn't commit. 'failed' (or pending_infra).
  if (finalCode === null) {
    return infraDegraded && env().PENDING_INFRA_ENABLED ? 'pending_infra' : 'failed';
  }
  // Code present. verdict is PASS (succeeded) or FLAG (flagged). null
  // verdict with a code shouldn't happen — defensive default = flagged.
  const natural: ClassificationOutcome =
    verdict === 'PASS' ? 'succeeded' : 'flagged';
  return infraDegraded && env().PENDING_INFRA_ENABLED ? 'pending_infra' : natural;
}

/**
 * Run Phase 1 for one batch. Phase 1 NEVER throws on per-item
 * failures; those land as status='failed'. It only throws on infrastructure
 * errors (DB unreachable, etc.) — the use-case turns that into a top-level
 * batch failure.
 */
export async function runClassificationPhase(
  batchId: string,
  opts: RunOptions,
): Promise<PhaseClassificationSummary> {
  const startMs = Date.now();
  await markClassificationPhase(batchId, 'running');

  const concurrency = opts.concurrency ?? env().BATCH_LLM_CONCURRENCY;
  const run = withSemaphore(concurrency);

  const pending = await listPendingItems(batchId);
  const counts = { succeeded: 0, flagged: 0, blocked: 0, failed: 0, pending_infra: 0 };

  await Promise.all(
    pending.map((row) =>
      run(async () => {
        // Stamp the batch id on the in-flight item so dispatch can
        // propagate it to enqueueHitl as hitl_queue.batch_id (added in
        // migration 0075). The canonical jsonb on disk doesn't carry
        // this field; we attach it transiently here.
        const item: CanonicalLineItem = {
          ...(row.canonical as unknown as CanonicalLineItem),
          batchId,
        };
        // Fast-fail: if the breaker is already tripped (this batch started
        // healthy but later items hit a degraded Foundry, OR the breaker
        // tripped on item N's call and items N+1..K are still queued), skip
        // the dispatch attempt and record the same error. This avoids
        // dozens of redundant 401/403 calls during an outage and keeps the
        // failure reason consistent across the batch.
        if (isBreakerTripped()) {
          counts.failed++;
          const status = breakerStatus();
          await recordItemResult({
            itemId: row.id,
            outcome: 'failed',
            finalCode: null,
            goodsDescriptionAr: null,
            classificationResult: null,
            trace: null,
            error: `llm_unavailable: ${status.last_error ?? 'circuit breaker tripped'}`,
          });
          return;
        }
        await markItemClassifying(row.id);
        try {
          const result: DispatchResult = await opts.dispatch(item);
          const outcome = classifyOutcome(
            result.sanityVerdict,
            result.finalCode,
            result.infraDegraded,
            result.shortCircuit ?? false,
          );
          counts[outcome]++;
          // pending_infra is allowed to carry final_code + goods_description_ar
          // when the pipeline produced them (migration 0077 widens both
          // consistency CHECKs). succeeded/flagged carry them as before;
          // blocked/failed/pending_infra-without-code stay null.
          const carriesCode =
            outcome === 'succeeded' ||
            outcome === 'flagged' ||
            (outcome === 'pending_infra' && result.finalCode !== null);
          await recordItemResult({
            itemId: row.id,
            outcome,
            finalCode: carriesCode ? result.finalCode : null,
            goodsDescriptionAr: carriesCode ? result.goodsDescriptionAr : null,
            classificationResult: serialiseResult(result),
            trace: result.trace,
            error: outcome === 'failed' && result.finalCode === null
              ? 'Pipeline escalated to HITL with no code; see hitl_queue for review.'
              : null,
          });
        } catch (err) {
          counts.failed++;
          await recordItemResult({
            itemId: row.id,
            outcome: 'failed',
            finalCode: null,
            goodsDescriptionAr: null,
            classificationResult: null,
            trace: null,
            error: truncateError(err),
          });
        }
      }),
    ),
  );

  await markClassificationPhase(batchId, 'completed');

  return {
    total: pending.length,
    succeeded: counts.succeeded,
    flagged: counts.flagged,
    blocked: counts.blocked,
    failed: counts.failed,
    pending_infra: counts.pending_infra,
    durationMs: Date.now() - startMs,
  };
}

function serialiseResult(r: DispatchResult): Record<string, unknown> {
  // `path_taken` was a legacy track-A/track-B presence indicator; it had
  // zero readers across backend, frontend, tests, and SQL queries (see
  // PR-A-5 audit). Dropped rather than ported to anchored vocabulary.
  return {
    final_code: r.finalCode,
    sanity_verdict: r.sanityVerdict,
  };
}

function truncateError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 500 ? msg.slice(0, 500) + '…' : msg;
}

// Suppress unused symbol when ItemTrace is consumed only via type imports.
// (No-op; kept so removing it is intentional, not a slip.)
export type { ItemTrace };
