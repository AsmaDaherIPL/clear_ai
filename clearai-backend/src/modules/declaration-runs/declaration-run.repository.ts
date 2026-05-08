/**
 * Drizzle queries for declaration_runs + declaration_run_items.
 *
 * The two-phase status fields (classification_status / declaration_status)
 * are written via dedicated phase repositories
 * (classification.repository / declaration.repository); this module owns
 * CRUD + cross-phase queries (insertDeclarationRun, getDeclarationRun,
 * listItems, countItemsByStatus).
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  declarationRuns,
  declarationRunItems,
  type ClassificationStatus,
  type DeclarationStatus,
  type DeclarationRunItemRow,
  type DeclarationRunItemStatus,
  type DeclarationRunMode,
  type DeclarationRunRow,
  type DeclarationRunStatus,
  type NewDeclarationRunItemRow,
} from '../../db/schema.js';
import type { CanonicalLineItem, RawRow } from '../operators/operator-config.types.js';
import { DeclarationRunNotFoundError } from './declaration-run.errors.js';

/**
 * One paired (canonical, rawRow) record. The repository writes them into
 * sibling jsonb columns; rawRow stays out of canonical so column-level PII
 * grants work (see migration 0043 + ADR `batch-items-canonical-jsonb.md`).
 */
export interface DeclarationRunItemInput {
  canonical: CanonicalLineItem;
  rawRow: RawRow;
}

export interface InsertDeclarationRunInput {
  /** Pre-allocated uuid so the caller can build deterministic blob paths. */
  declarationRunId: string;
  operatorId: string;
  mode: DeclarationRunMode;
  sourceBlobKey: string;
  /** Tree-layout prefix locked in at creation time (e.g. naqel/2026/05/08/<run_id>). */
  blobPrefix: string;
  rowCount: number;
  metadata: Record<string, unknown>;
  items: ReadonlyArray<DeclarationRunItemInput>;
}

/**
 * Insert a declaration_run row + every declaration_run_items row in a
 * single transaction. Sets initial classification_status='pending';
 * declaration_status='pending' iff mode='classify_and_declare', NULL
 * otherwise (per the DB consistency CHECK).
 */
export async function insertDeclarationRun(input: InsertDeclarationRunInput): Promise<DeclarationRunRow> {
  return db().transaction(async (tx) => {
    const declStatus: DeclarationStatus | null =
      input.mode === 'classify_and_declare' ? 'pending' : null;

    const inserted = await tx
      .insert(declarationRuns)
      .values({
        id: input.declarationRunId,
        operatorId: input.operatorId,
        mode: input.mode,
        status: 'pending',
        classificationStatus: 'pending',
        declarationStatus: declStatus,
        sourceBlobKey: input.sourceBlobKey,
        blobPrefix: input.blobPrefix,
        rowCount: input.rowCount,
        metadata: input.metadata,
      })
      .returning();
    const declarationRun = inserted[0]!;

    const rows: NewDeclarationRunItemRow[] = input.items.map(({ canonical, rawRow }) => ({
      id: canonical.itemId,
      declarationRunId: declarationRun.id,
      rowIndex: canonical.rowIndex,
      canonical,
      rawRow,
      status: 'pending',
    }));

    if (rows.length > 0) {
      // Chunked insert to avoid hitting Postgres parameter limits.
      const CHUNK = 200;
      for (let i = 0; i < rows.length; i += CHUNK) {
        await tx.insert(declarationRunItems).values(rows.slice(i, i + CHUNK));
      }
    }

    return declarationRun;
  });
}

export async function getDeclarationRun(id: string): Promise<DeclarationRunRow> {
  const rows = await db().select().from(declarationRuns).where(eq(declarationRuns.id, id)).limit(1);
  if (!rows[0]) throw new DeclarationRunNotFoundError(id);
  return rows[0];
}

export async function listItems(declarationRunId: string): Promise<DeclarationRunItemRow[]> {
  return db()
    .select()
    .from(declarationRunItems)
    .where(eq(declarationRunItems.declarationRunId, declarationRunId))
    .orderBy(declarationRunItems.rowIndex);
}

export async function countItemsByStatus(
  declarationRunId: string,
): Promise<Record<DeclarationRunItemStatus, number>> {
  const rows = await db()
    .select({ status: declarationRunItems.status, n: sql<number>`count(*)::int` })
    .from(declarationRunItems)
    .where(eq(declarationRunItems.declarationRunId, declarationRunId))
    .groupBy(declarationRunItems.status);
  const out: Record<DeclarationRunItemStatus, number> = {
    pending: 0,
    classifying: 0,
    succeeded: 0,
    flagged: 0,
    blocked: 0,
    failed: 0,
  };
  for (const r of rows) out[r.status as DeclarationRunItemStatus] = Number(r.n);
  return out;
}

export async function setDeclarationRunStatus(
  id: string,
  patch: Partial<{
    status: DeclarationRunStatus;
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
  await db().update(declarationRuns).set(set).where(eq(declarationRuns.id, id));
}

export async function cancelDeclarationRunIfActive(id: string): Promise<DeclarationRunRow> {
  const declarationRun = await getDeclarationRun(id);
  const TERMINAL: DeclarationRunStatus[] = ['completed', 'failed', 'cancelled'];
  if (TERMINAL.includes(declarationRun.status as DeclarationRunStatus)) {
    return declarationRun;
  }
  await db()
    .update(declarationRuns)
    .set({ status: 'cancelled', completedAt: new Date() })
    .where(and(eq(declarationRuns.id, id)));
  return getDeclarationRun(id);
}
