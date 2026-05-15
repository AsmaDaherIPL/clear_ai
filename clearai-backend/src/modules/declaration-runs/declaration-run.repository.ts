/**
 * Drizzle queries for declaration_runs + declaration_run_items.
 *
 * The two-phase status fields (classification_status / declaration_status)
 * are written via dedicated phase repositories
 * (classification.repository / declaration.repository); this module owns
 * CRUD + cross-phase queries (insertDeclarationRun, getBatch,
 * listItems, countItemsByStatus).
 */
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  declarationRuns,
  declarationRunItems,
  operators,
  type ClassificationStatus,
  type DeclarationStatus,
  type BatchItemRow,
  type BatchItemStatus,
  type BatchMode,
  type DeclarationRunRow,
  type BatchStatus,
  type NewDeclarationRunItemRow,
} from '../../db/schema.js';
import type { CanonicalLineItem, RawRow } from '../operators/operator-config.types.js';
import { BatchNotFoundError } from './declaration-run.errors.js';

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
  mode: BatchMode;
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

export async function getBatch(id: string): Promise<DeclarationRunRow> {
  const rows = await db().select().from(declarationRuns).where(eq(declarationRuns.id, id)).limit(1);
  if (!rows[0]) throw new BatchNotFoundError(id);
  return rows[0];
}

export async function listItems(declarationRunId: string): Promise<BatchItemRow[]> {
  return db()
    .select()
    .from(declarationRunItems)
    .where(eq(declarationRunItems.declarationRunId, declarationRunId))
    .orderBy(declarationRunItems.rowIndex);
}

export async function countItemsByStatus(
  declarationRunId: string,
): Promise<Record<BatchItemStatus, number>> {
  const rows = await db()
    .select({ status: declarationRunItems.status, n: sql<number>`count(*)::int` })
    .from(declarationRunItems)
    .where(eq(declarationRunItems.declarationRunId, declarationRunId))
    .groupBy(declarationRunItems.status);
  const out: Record<BatchItemStatus, number> = {
    pending: 0,
    classifying: 0,
    succeeded: 0,
    flagged: 0,
    blocked: 0,
    pending_infra: 0,
    failed: 0,
  };
  for (const r of rows) out[r.status as BatchItemStatus] = Number(r.n);
  return out;
}

export async function setDeclarationRunStatus(
  id: string,
  patch: Partial<{
    status: BatchStatus;
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

export async function cancelBatchIfActive(id: string): Promise<DeclarationRunRow> {
  const declarationRun = await getBatch(id);
  const TERMINAL: BatchStatus[] = ['completed', 'failed', 'cancelled'];
  if (TERMINAL.includes(declarationRun.status as BatchStatus)) {
    return declarationRun;
  }
  await db()
    .update(declarationRuns)
    .set({ status: 'cancelled', completedAt: new Date() })
    .where(and(eq(declarationRuns.id, id)));
  return getBatch(id);
}

/**
 * One row from listBatches — pre-joined with operators so the caller
 * doesn't need an N+1 slug lookup. Shape matches the slim wire format
 * for GET /batches; consumers that need full per-row counts should
 * fetch GET /batches/:id which calls countItemsByStatus.
 */
export interface BatchListItem {
  id: string;
  operatorSlug: string;
  mode: BatchMode;
  status: BatchStatus;
  classificationStatus: ClassificationStatus;
  declarationStatus: DeclarationStatus | null;
  rowCount: number;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  error: string | null;
}

export interface ListBatchesParams {
  /** ≥1; caller clamps to ≤500 at the route layer. */
  limit: number;
  /** ≥0. */
  offset: number;
  /** Optional whitelist of statuses (OR semantics across the array). */
  statuses?: ReadonlyArray<BatchStatus>;
  /** Inclusive lower bound on declaration_runs.created_at. */
  createdSince?: Date;
  /** Inclusive upper bound on declaration_runs.created_at. */
  createdUntil?: Date;
}

/**
 * List declaration_runs newest-first with optional status + date filters,
 * pre-joined with the operators table so each row carries `operatorSlug`
 * directly (no N+1 lookups).
 *
 * Sort order is `created_at DESC` — the SPA's batch index page is
 * always "latest first" and `created_at` is monotonic per batch. Total
 * count is returned separately so the caller can paginate.
 *
 * Filters compose with AND semantics; passing nothing returns the
 * latest `limit` batches across all statuses + all time.
 */
export async function listBatches(
  params: ListBatchesParams,
): Promise<{ items: BatchListItem[]; total: number }> {
  const filters = [];
  if (params.statuses !== undefined && params.statuses.length > 0) {
    filters.push(inArray(declarationRuns.status, params.statuses as BatchStatus[]));
  }
  if (params.createdSince !== undefined) {
    filters.push(gte(declarationRuns.createdAt, params.createdSince));
  }
  if (params.createdUntil !== undefined) {
    filters.push(lte(declarationRuns.createdAt, params.createdUntil));
  }
  const whereClause = filters.length > 0 ? and(...filters) : undefined;

  // Page rows + total count run in parallel — separate queries because
  // window aggregates would force a full table scan when the filter is
  // selective. count(*) on an indexed status+created_at query plan is
  // sub-ms even at 100k rows.
  const [rows, totalRows] = await Promise.all([
    db()
      .select({
        id: declarationRuns.id,
        operatorSlug: operators.slug,
        mode: declarationRuns.mode,
        status: declarationRuns.status,
        classificationStatus: declarationRuns.classificationStatus,
        declarationStatus: declarationRuns.declarationStatus,
        rowCount: declarationRuns.rowCount,
        createdAt: declarationRuns.createdAt,
        startedAt: declarationRuns.startedAt,
        completedAt: declarationRuns.completedAt,
        error: declarationRuns.error,
      })
      .from(declarationRuns)
      .leftJoin(operators, eq(declarationRuns.operatorId, operators.id))
      .where(whereClause)
      .orderBy(desc(declarationRuns.createdAt))
      .limit(params.limit)
      .offset(params.offset),
    db()
      .select({ n: sql<number>`count(*)::int` })
      .from(declarationRuns)
      .where(whereClause),
  ]);

  const items: BatchListItem[] = rows.map((r) => ({
    id: r.id,
    // operators.slug is non-null by schema; left-joining preserves the row
    // if the FK ever broke. Default to '' for that defensive edge.
    operatorSlug: r.operatorSlug ?? '',
    mode: r.mode as BatchMode,
    status: r.status as BatchStatus,
    classificationStatus: r.classificationStatus as ClassificationStatus,
    declarationStatus: (r.declarationStatus ?? null) as DeclarationStatus | null,
    rowCount: r.rowCount,
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    error: r.error,
  }));

  return { items, total: Number(totalRows[0]?.n ?? 0) };
}
