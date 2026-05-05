/**
 * Phase 1 (classification) Drizzle queries scoped to declaration_set_items
 * mutations.
 *
 * v0 is single-process. We do NOT use SELECT FOR UPDATE SKIP LOCKED because
 * the orchestrator drives one in-process worker per declaration_set with a
 * p-limit semaphore — there's no across-process contention. If we move to a
 * worker per Container Apps Job (v2), this is the file that grows the
 * row-level lock.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import {
  declarationSetItems,
  declarationSets,
  type DeclarationSetItemRow,
  type ClassificationStatus,
} from '../../../db/schema.js';
import type {
  ClassificationOutcome,
  ItemTrace,
} from './classification.types.js';

export async function listPendingItems(declarationSetId: string): Promise<DeclarationSetItemRow[]> {
  return db()
    .select()
    .from(declarationSetItems)
    .where(and(eq(declarationSetItems.declarationSetId, declarationSetId), eq(declarationSetItems.status, 'pending')))
    .orderBy(declarationSetItems.rowIndex);
}

/** Optimistic transition pending -> classifying for a single item. */
export async function markItemClassifying(itemId: string): Promise<void> {
  await db()
    .update(declarationSetItems)
    .set({ status: 'classifying' })
    .where(and(eq(declarationSetItems.id, itemId), eq(declarationSetItems.status, 'pending')));
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
    .update(declarationSetItems)
    .set({
      status: rec.outcome,
      finalCode: rec.finalCode,
      goodsDescriptionAr: rec.goodsDescriptionAr,
      classificationResult: rec.classificationResult ?? null,
      trace: (rec.trace as unknown as Record<string, unknown>) ?? null,
      error: rec.error,
    })
    .where(eq(declarationSetItems.id, rec.itemId));
}

export async function markClassificationPhase(
  declarationSetId: string,
  status: ClassificationStatus,
  err?: string,
): Promise<void> {
  await db()
    .update(declarationSets)
    .set({
      classificationStatus: status,
      ...(err ? { error: err } : {}),
    })
    .where(eq(declarationSets.id, declarationSetId));
}
