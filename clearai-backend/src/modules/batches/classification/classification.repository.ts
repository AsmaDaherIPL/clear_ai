/**
 * Phase 1 (classification) Drizzle queries scoped to batch_items
 * mutations.
 *
 * v0 is single-process. We do NOT use SELECT FOR UPDATE SKIP LOCKED because
 * the orchestrator drives one in-process worker per batch with a
 * p-limit semaphore — there's no across-process contention. If we move to a
 * worker per Container Apps Job (v2), this is the file that grows the
 * row-level lock.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import {
  batchItems,
  batches,
  type BatchItemRow,
  type ClassificationStatus,
} from '../../../db/schema.js';
import type {
  ClassificationOutcome,
  ItemTrace,
} from './classification.types.js';

export async function listPendingItems(batchId: string): Promise<BatchItemRow[]> {
  return db()
    .select()
    .from(batchItems)
    .where(and(eq(batchItems.batchId, batchId), eq(batchItems.status, 'pending')))
    .orderBy(batchItems.rowIndex);
}

/**
 * Every row in the batch regardless of status. Used by the
 * classifications.json writer so the dump reflects 100% of the input
 * rows — including blocked / failed / pending_infra — not just the
 * happy-path succeeded+flagged.
 *
 * The prior writer mistakenly used listPendingItems(), thinking it
 * covered non-success states; it doesn't (the name + filter only ever
 * returned `status='pending'`, which is empty after Phase 1 completes).
 * That bug silently dropped ~50% of rows from NQM26051745946's dump
 * before this function existed. See dedicated commit message.
 */
export async function listAllItemsByBatch(batchId: string): Promise<BatchItemRow[]> {
  return db()
    .select()
    .from(batchItems)
    .where(eq(batchItems.batchId, batchId))
    .orderBy(batchItems.rowIndex);
}

/** Optimistic transition pending -> classifying for a single item. */
export async function markItemClassifying(itemId: string): Promise<void> {
  await db()
    .update(batchItems)
    .set({ status: 'classifying' })
    .where(and(eq(batchItems.id, itemId), eq(batchItems.status, 'pending')));
}

export interface ItemResultRecord {
  itemId: string;
  outcome: ClassificationOutcome;
  finalCode: string | null;
  goodsDescriptionAr: string | null;
  classificationResult: Record<string, unknown> | null;
  trace: ItemTrace | null;
  error: string | null;
}

export async function recordItemResult(rec: ItemResultRecord): Promise<void> {
  await db()
    .update(batchItems)
    .set({
      status: rec.outcome,
      finalCode: rec.finalCode,
      goodsDescriptionAr: rec.goodsDescriptionAr,
      classificationResult: rec.classificationResult ?? null,
      trace: (rec.trace as unknown as Record<string, unknown>) ?? null,
      error: rec.error,
    })
    .where(eq(batchItems.id, rec.itemId));
}

export async function markClassificationPhase(
  batchId: string,
  status: ClassificationStatus,
  err?: string,
): Promise<void> {
  await db()
    .update(batches)
    .set({
      classificationStatus: status,
      ...(err ? { error: err } : {}),
    })
    .where(eq(batches.id, batchId));
}
