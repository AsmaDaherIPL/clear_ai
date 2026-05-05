/**
 * Phase 2 (declaration) Drizzle queries. The `declarations` table is
 * created in migration 0044 (Phase 5 of this PR series); this file imports
 * it from the schema barrel.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { batchItems, batches, declarations, type BatchDeclarationStatus, type BatchItemRow } from '../../../db/schema.js';
import type { BundleStrategy } from './batch-declaration.types.js';

export async function listClassifiedItems(batchId: string): Promise<BatchItemRow[]> {
  return db()
    .select()
    .from(batchItems)
    .where(and(eq(batchItems.batchId, batchId), inArray(batchItems.status, ['succeeded', 'flagged'])))
    .orderBy(batchItems.rowIndex);
}

export interface RecordDeclarationInput {
  batchId: string;
  bundleIndex: number;
  strategy: BundleStrategy;
  itemCount: number;
  blobKey: string;
}

export async function recordDeclaration(input: RecordDeclarationInput): Promise<void> {
  await db().insert(declarations).values({
    batchId: input.batchId,
    bundleIndex: input.bundleIndex,
    bundleStrategy: input.strategy,
    itemCount: input.itemCount,
    blobKey: input.blobKey,
  });
}

export async function markBatchDeclarationPhase(
  batchId: string,
  status: BatchDeclarationStatus,
  err?: string,
): Promise<void> {
  await db()
    .update(batches)
    .set({
      declarationStatus: status,
      ...(err ? { error: err } : {}),
    })
    .where(eq(batches.id, batchId));
}
