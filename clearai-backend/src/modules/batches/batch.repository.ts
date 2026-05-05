/**
 * Drizzle queries for batches + batch_items.
 *
 * The two-phase tables (batches.classification_status / declaration_status)
 * are written via dedicated phase repositories
 * (batch-classification.repository / batch-declaration.repository); this
 * module owns CRUD + cross-phase queries (insertBatch, getBatch, listItems,
 * countItemsByStatus).
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  batches,
  batchItems,
  type BatchClassificationStatus,
  type BatchDeclarationStatus,
  type BatchItemRow,
  type BatchItemStatus,
  type BatchMode,
  type BatchRow,
  type BatchStatus,
  type NewBatchItemRow,
} from '../../db/schema.js';
import type { CanonicalLineItem, RawRow } from '../tenants/tenant-config.types.js';
import { BatchNotFoundError } from './batch.errors.js';

/**
 * One paired (canonical, rawRow) record. The repository writes them into
 * sibling jsonb columns; rawRow stays out of canonical so column-level PII
 * grants work (see migration 0043 + ADR `batch-items-canonical-jsonb.md`).
 */
export interface BatchItemInput {
  canonical: CanonicalLineItem;
  rawRow: RawRow;
}

export interface InsertBatchInput {
  /** Pre-allocated uuid so the caller can build deterministic blob paths. */
  batchId: string;
  tenantSlug: string;
  mode: BatchMode;
  sourceBlobKey: string;
  rowCount: number;
  metadata: Record<string, unknown>;
  items: ReadonlyArray<BatchItemInput>;
}

/**
 * Insert a batch row + every batch_items row in a single transaction.
 * Sets initial classification_status='pending'; declaration_status='pending'
 * iff mode='classify_and_declare', NULL otherwise (per the DB consistency CHECK).
 */
export async function insertBatch(input: InsertBatchInput): Promise<BatchRow> {
  return db().transaction(async (tx) => {
    const batchId = input.batchId;
    const declStatus: BatchDeclarationStatus | null =
      input.mode === 'classify_and_declare' ? 'pending' : null;

    const inserted = await tx
      .insert(batches)
      .values({
        id: batchId,
        tenant: input.tenantSlug,
        mode: input.mode,
        status: 'pending',
        classificationStatus: 'pending',
        declarationStatus: declStatus,
        sourceBlobKey: input.sourceBlobKey,
        rowCount: input.rowCount,
        metadata: input.metadata,
      })
      .returning();
    const batch = inserted[0]!;

    const rows: NewBatchItemRow[] = input.items.map(({ canonical, rawRow }) => ({
      id: canonical.itemId,
      batchId: batch.id,
      rowIndex: canonical.rowIndex,
      canonical,
      rawRow,
      status: 'pending',
    }));

    if (rows.length > 0) {
      // Single insert; chunked to avoid hitting parameter limits on huge batches.
      const CHUNK = 200;
      for (let i = 0; i < rows.length; i += CHUNK) {
        await tx.insert(batchItems).values(rows.slice(i, i + CHUNK));
      }
    }

    return batch;
  });
}

export async function getBatch(id: string): Promise<BatchRow> {
  const rows = await db().select().from(batches).where(eq(batches.id, id)).limit(1);
  if (!rows[0]) throw new BatchNotFoundError(id);
  return rows[0];
}

export async function listItems(batchId: string): Promise<BatchItemRow[]> {
  return db().select().from(batchItems).where(eq(batchItems.batchId, batchId)).orderBy(batchItems.rowIndex);
}

export async function countItemsByStatus(batchId: string): Promise<Record<BatchItemStatus, number>> {
  const rows = await db()
    .select({ status: batchItems.status, n: sql<number>`count(*)::int` })
    .from(batchItems)
    .where(eq(batchItems.batchId, batchId))
    .groupBy(batchItems.status);
  const out: Record<BatchItemStatus, number> = {
    pending: 0,
    classifying: 0,
    succeeded: 0,
    flagged: 0,
    blocked: 0,
    failed: 0,
  };
  for (const r of rows) out[r.status as BatchItemStatus] = Number(r.n);
  return out;
}

export async function setBatchStatus(
  id: string,
  patch: Partial<{
    status: BatchStatus;
    classificationStatus: BatchClassificationStatus;
    declarationStatus: BatchDeclarationStatus | null;
    startedAt: Date | null;
    completedAt: Date | null;
    error: string | null;
    resultBlobKey: string | null;
  }>,
): Promise<void> {
  const set: Record<string, unknown> = {};
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.classificationStatus !== undefined) set.classificationStatus = patch.classificationStatus;
  if (patch.declarationStatus !== undefined) set.declarationStatus = patch.declarationStatus;
  if (patch.startedAt !== undefined) set.startedAt = patch.startedAt;
  if (patch.completedAt !== undefined) set.completedAt = patch.completedAt;
  if (patch.error !== undefined) set.error = patch.error;
  if (patch.resultBlobKey !== undefined) set.resultBlobKey = patch.resultBlobKey;
  if (Object.keys(set).length === 0) return;
  await db().update(batches).set(set).where(eq(batches.id, id));
}

export async function cancelBatchIfActive(id: string): Promise<BatchRow> {
  const batch = await getBatch(id);
  const TERMINAL: BatchStatus[] = ['completed', 'failed', 'cancelled'];
  if (TERMINAL.includes(batch.status as BatchStatus)) {
    return batch;
  }
  await db()
    .update(batches)
    .set({ status: 'cancelled', completedAt: new Date() })
    .where(and(eq(batches.id, id)));
  return getBatch(id);
}
