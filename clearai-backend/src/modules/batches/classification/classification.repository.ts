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
