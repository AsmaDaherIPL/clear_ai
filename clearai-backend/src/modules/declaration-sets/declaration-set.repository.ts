/**
 * Drizzle queries for declaration_sets + declaration_set_items.
 *
 * The two-phase status fields (classification_status / declaration_status)
 * are written via dedicated phase repositories
 * (classification.repository / declaration.repository); this module owns
 * CRUD + cross-phase queries (insertDeclarationSet, getDeclarationSet,
 * listItems, countItemsByStatus).
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  declarationSets,
  declarationSetItems,
  type ClassificationStatus,
  type DeclarationStatus,
  type DeclarationSetItemRow,
  type DeclarationSetItemStatus,
  type DeclarationSetMode,
  type DeclarationSetRow,
  type DeclarationSetStatus,
  type NewDeclarationSetItemRow,
} from '../../db/schema.js';
import type { CanonicalLineItem, RawRow } from '../tenants/tenant-config.types.js';
import { DeclarationSetNotFoundError } from './declaration-set.errors.js';

/**
 * One paired (canonical, rawRow) record. The repository writes them into
 * sibling jsonb columns; rawRow stays out of canonical so column-level PII
 * grants work (see migration 0043 + ADR `batch-items-canonical-jsonb.md`).
 */
export interface DeclarationSetItemInput {
  canonical: CanonicalLineItem;
  rawRow: RawRow;
}

export interface InsertDeclarationSetInput {
  /** Pre-allocated uuid so the caller can build deterministic blob paths. */
  declarationSetId: string;
  tenantSlug: string;
  mode: DeclarationSetMode;
  sourceBlobKey: string;
  rowCount: number;
  metadata: Record<string, unknown>;
  items: ReadonlyArray<DeclarationSetItemInput>;
}

/**
 * Insert a declaration_set row + every declaration_set_items row in a
 * single transaction. Sets initial classification_status='pending';
 * declaration_status='pending' iff mode='classify_and_declare', NULL
 * otherwise (per the DB consistency CHECK).
 */
export async function insertDeclarationSet(input: InsertDeclarationSetInput): Promise<DeclarationSetRow> {
  return db().transaction(async (tx) => {
    const declStatus: DeclarationStatus | null =
      input.mode === 'classify_and_declare' ? 'pending' : null;

    const inserted = await tx
      .insert(declarationSets)
      .values({
        id: input.declarationSetId,
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
    const declarationSet = inserted[0]!;

    const rows: NewDeclarationSetItemRow[] = input.items.map(({ canonical, rawRow }) => ({
      id: canonical.itemId,
      declarationSetId: declarationSet.id,
      rowIndex: canonical.rowIndex,
      canonical,
      rawRow,
      status: 'pending',
    }));

    if (rows.length > 0) {
      // Chunked insert to avoid hitting Postgres parameter limits.
      const CHUNK = 200;
      for (let i = 0; i < rows.length; i += CHUNK) {
        await tx.insert(declarationSetItems).values(rows.slice(i, i + CHUNK));
      }
    }

    return declarationSet;
  });
}

export async function getDeclarationSet(id: string): Promise<DeclarationSetRow> {
  const rows = await db().select().from(declarationSets).where(eq(declarationSets.id, id)).limit(1);
  if (!rows[0]) throw new DeclarationSetNotFoundError(id);
  return rows[0];
}

export async function listItems(declarationSetId: string): Promise<DeclarationSetItemRow[]> {
  return db()
    .select()
    .from(declarationSetItems)
    .where(eq(declarationSetItems.declarationSetId, declarationSetId))
    .orderBy(declarationSetItems.rowIndex);
}

export async function countItemsByStatus(
  declarationSetId: string,
): Promise<Record<DeclarationSetItemStatus, number>> {
  const rows = await db()
    .select({ status: declarationSetItems.status, n: sql<number>`count(*)::int` })
    .from(declarationSetItems)
    .where(eq(declarationSetItems.declarationSetId, declarationSetId))
    .groupBy(declarationSetItems.status);
  const out: Record<DeclarationSetItemStatus, number> = {
    pending: 0,
    classifying: 0,
    succeeded: 0,
    flagged: 0,
    blocked: 0,
    failed: 0,
  };
  for (const r of rows) out[r.status as DeclarationSetItemStatus] = Number(r.n);
  return out;
}

export async function setDeclarationSetStatus(
  id: string,
  patch: Partial<{
    status: DeclarationSetStatus;
    classificationStatus: ClassificationStatus;
    declarationStatus: DeclarationStatus | null;
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
  await db().update(declarationSets).set(set).where(eq(declarationSets.id, id));
}

export async function cancelDeclarationSetIfActive(id: string): Promise<DeclarationSetRow> {
  const declarationSet = await getDeclarationSet(id);
  const TERMINAL: DeclarationSetStatus[] = ['completed', 'failed', 'cancelled'];
  if (TERMINAL.includes(declarationSet.status as DeclarationSetStatus)) {
    return declarationSet;
  }
  await db()
    .update(declarationSets)
    .set({ status: 'cancelled', completedAt: new Date() })
    .where(and(eq(declarationSets.id, id)));
  return getDeclarationSet(id);
}
