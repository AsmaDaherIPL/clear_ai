/**
 * Phase 1 — classification service.
 * Runs for every declaration_run regardless of mode.
 *
 * Drives `dispatch(item)` per pending row under a p-limit semaphore
 * (BATCH_LLM_CONCURRENCY). NEVER touches XML, ZATCA, or blob storage.
 */
import { env } from '../../../config/env.js';
import { withSemaphore } from '../../../common/concurrency/semaphore.js';
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
import type { CanonicalLineItem } from '../../tenants/tenant-config.types.js';
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

function classifyOutcome(verdict: SanityVerdict): ClassificationOutcome {
  switch (verdict) {
    case 'PASS':
      return 'succeeded';
    case 'FLAG':
      return 'flagged';
    case 'BLOCK':
      return 'blocked';
  }
}

/**
 * Run Phase 1 for one declaration_run. Phase 1 NEVER throws on per-item
 * failures; those land as status='failed'. It only throws on infrastructure
 * errors (DB unreachable, etc.) — the use-case turns that into a top-level
 * declaration_run failure.
 */
export async function runClassificationPhase(
  declarationRunId: string,
  opts: RunOptions,
): Promise<PhaseClassificationSummary> {
  const startMs = Date.now();
  await markClassificationPhase(declarationRunId, 'running');

  const concurrency = opts.concurrency ?? env().BATCH_LLM_CONCURRENCY;
  const run = withSemaphore(concurrency);

  const pending = await listPendingItems(declarationRunId);
  const counts = { succeeded: 0, flagged: 0, blocked: 0, failed: 0 };

  await Promise.all(
    pending.map((row) =>
      run(async () => {
        const item = row.canonical as unknown as CanonicalLineItem;
        await markItemClassifying(row.id);
        try {
          const result: DispatchResult = await opts.dispatch(item);
          const outcome = classifyOutcome(result.sanityVerdict);
          counts[outcome]++;
          const succeededOrFlagged = outcome === 'succeeded' || outcome === 'flagged';
          await recordItemResult({
            itemId: row.id,
            outcome,
            finalCode: succeededOrFlagged ? result.finalCode : null,
            goodsDescriptionAr: succeededOrFlagged ? result.goodsDescriptionAr : null,
            classificationResult: serialiseResult(result),
            trace: result.trace,
            error: null,
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

  await markClassificationPhase(declarationRunId, 'completed');

  return {
    total: pending.length,
    succeeded: counts.succeeded,
    flagged: counts.flagged,
    blocked: counts.blocked,
    failed: counts.failed,
    durationMs: Date.now() - startMs,
  };
}

function serialiseResult(r: DispatchResult): Record<string, unknown> {
  return {
    final_code: r.finalCode,
    sanity_verdict: r.sanityVerdict,
    path_taken: r.trace.pathTaken,
  };
}

function truncateError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 500 ? msg.slice(0, 500) + '…' : msg;
}

// Suppress unused symbol when ItemTrace is consumed only via type imports.
// (No-op; kept so removing it is intentional, not a slip.)
export type { ItemTrace };
