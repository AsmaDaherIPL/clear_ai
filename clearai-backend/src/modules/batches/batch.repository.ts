/**
 * Drizzle queries for batches + batch_items.
 *
 * The two-phase status fields (classification_status / declaration_status)
 * are written via dedicated phase repositories
 * (classification.repository / declaration.repository); this module owns
 * CRUD + cross-phase queries (insertBatch, getBatch,
 * listItems, countItemsByStatus).
 */
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { db, getPool } from '../../db/client.js';
import {
  batches,
  batchItems,
  operators,
  type ClassificationStatus,
  type DeclarationStatus,
  type BatchItemRow,
  type BatchItemStatus,
  type BatchMode,
  type BatchRow,
  type BatchStatus,
} from '../../db/schema.js';
import type { CanonicalLineItem, RawRow } from '../operators/operator-config.types.js';
import { BatchNotFoundError } from './batch.errors.js';
import type {
  GroupedNaqelCsv,
  TempManifestId,
  TempAwbId,
} from './parsers/naqel-csv.grouper.js';
import { insertManifest, insertAwb } from './manifest.repository.js';

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
  operatorId: string;
  mode: BatchMode;
  sourceBlobKey: string;
  /** Tree-layout prefix locked in at creation time (e.g. naqel/2026/05/08/<batch_id>). */
  blobPrefix: string;
  rowCount: number;
  metadata: Record<string, unknown>;
  items: ReadonlyArray<BatchItemInput>;
  /**
   * Optional manifest/AWB hierarchy (PR3). When present, the repository
   * persists the manifests + AWBs first, then writes each item with its
   * `awb_id` FK populated. The grouped payload's temp ids are mapped to
   * real UUIDs inside the transaction; the corresponding canonical's
   * `awbId` field is overwritten with the real value before insert.
   *
   * When absent (legacy path / non-Naqel operators), items are inserted
   * with `awb_id = NULL` and no manifests/awbs are created.
   */
  hierarchy?: GroupedNaqelCsv;
}

/**
 * Insert a batches row + every batch_items row (and optionally
 * manifests + awbs from a Naqel-style ingest) in a single transaction.
 * Sets initial classification_status='pending'; declaration_status='pending'
 * iff mode='classify_and_declare', NULL otherwise (per the DB consistency CHECK).
 */
export async function insertBatch(input: InsertBatchInput): Promise<BatchRow> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const declStatus: DeclarationStatus | null =
      input.mode === 'classify_and_declare' ? 'pending' : null;

    const batchInsert = await client.query<BatchRow>(
      `INSERT INTO batches (
         id, operator_id, mode, status, classification_status, declaration_status,
         source_blob_key, blob_prefix, row_count, metadata
       )
       VALUES ($1, $2, $3, 'pending', 'pending', $4, $5, $6, $7, $8::jsonb)
       RETURNING id, operator_id AS "operatorId", mode, status,
                 classification_status AS "classificationStatus",
                 declaration_status AS "declarationStatus",
                 source_blob_key AS "sourceBlobKey",
                 result_blob_key AS "resultBlobKey",
                 blob_prefix AS "blobPrefix",
                 row_count AS "rowCount", metadata,
                 error,
                 created_at AS "createdAt", started_at AS "startedAt",
                 completed_at AS "completedAt", updated_at AS "updatedAt"`,
      [
        input.batchId,
        input.operatorId,
        input.mode,
        declStatus,
        input.sourceBlobKey,
        input.blobPrefix,
        input.rowCount,
        JSON.stringify(input.metadata),
      ],
    );
    const batch = batchInsert.rows[0]!;

    // PR3 hierarchy path. Insert manifests + awbs first; record temp-id
    // to real-id maps so items can carry awb_id.
    const manifestIdByTemp = new Map<TempManifestId, string>();
    const awbIdByTemp = new Map<TempAwbId, string>();

    if (input.hierarchy !== undefined) {
      for (const m of input.hierarchy.manifests) {
        const row = await insertManifest(client, {
          batchId: batch.id,
          mawbNo: m.mawbNo,
          manifestedAt: m.manifestedAt,
        });
        manifestIdByTemp.set(m.tempId, row.id);
      }
      for (const a of input.hierarchy.awbs) {
        const manifestId = manifestIdByTemp.get(a.manifestTempId);
        if (manifestId === undefined) {
          throw new Error(
            `insertBatch invariant: awb ${a.tempId} references unknown manifest ${a.manifestTempId}`,
          );
        }
        const row = await insertAwb(client, {
          manifestId,
          awbNo: a.awbNo,
          consigneeNationalId: a.consigneeNationalId,
          consigneeName: a.consigneeName,
          consigneeMobile: a.consigneeMobile,
          consigneePhone: a.consigneePhone,
          consigneeBirthDate: a.consigneeBirthDate,
          consigneeDest: a.consigneeDest,
          consigneeDestStation: a.consigneeDestStation,
        });
        awbIdByTemp.set(a.tempId, row.id);
      }
    }

    // Items: stamp awb_id when we have a hierarchy, else NULL.
    const itemRows = input.items.map(({ canonical, rawRow }) => {
      let awbDbId: string | null = null;
      // Two paths to surface awb temp id:
      //  1. The canonical was stamped with the temp id by the caller (e.g.
      //     parser put GroupedItem.awbTempId on canonical.awbId).
      //  2. The hierarchy is provided but the canonical doesn't carry it
      //     (shouldn't happen with the parser; defensive).
      if (input.hierarchy !== undefined && canonical.awbId !== undefined) {
        // canonical.awbId at insert time is the TempAwbId; resolve.
        const realId = awbIdByTemp.get(canonical.awbId as TempAwbId);
        if (realId !== undefined) awbDbId = realId;
      }
      return { canonical, rawRow, awbDbId, finalCanonical: { ...canonical, awbId: awbDbId ?? undefined } };
    });

    if (itemRows.length > 0) {
      // Chunked insert via raw SQL so we can fan-out awb_id per row.
      const CHUNK = 200;
      for (let i = 0; i < itemRows.length; i += CHUNK) {
        const chunk = itemRows.slice(i, i + CHUNK);
        const valuesSql: string[] = [];
        const params: unknown[] = [];
        let p = 1;
        for (const r of chunk) {
          valuesSql.push(`($${p++}, $${p++}, $${p++}, $${p++}::jsonb, $${p++}::jsonb, 'pending', $${p++})`);
          params.push(
            r.finalCanonical.itemId,
            batch.id,
            r.finalCanonical.rowIndex,
            JSON.stringify(r.finalCanonical),
            JSON.stringify(r.rawRow),
            r.awbDbId,
          );
        }
        await client.query(
          `INSERT INTO batch_items (id, batch_id, row_index, canonical, raw_row, status, awb_id)
           VALUES ${valuesSql.join(', ')}`,
          params,
        );
      }
    }

    await client.query('COMMIT');
    return batch;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function getBatch(id: string): Promise<BatchRow> {
  const rows = await db().select().from(batches).where(eq(batches.id, id)).limit(1);
  if (!rows[0]) throw new BatchNotFoundError(id);
  return rows[0];
}

export async function listItems(batchId: string): Promise<BatchItemRow[]> {
  return db()
    .select()
    .from(batchItems)
    .where(eq(batchItems.batchId, batchId))
    .orderBy(batchItems.rowIndex);
}

export async function countItemsByStatus(
  batchId: string,
): Promise<Record<BatchItemStatus, number>> {
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
    pending_infra: 0,
    failed: 0,
  };
  for (const r of rows) out[r.status as BatchItemStatus] = Number(r.n);
  return out;
}

export async function setBatchStatus(
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
  /** Inclusive lower bound on batches.created_at. */
  createdSince?: Date;
  /** Inclusive upper bound on batches.created_at. */
  createdUntil?: Date;
}

/**
 * List batches newest-first with optional status + date filters,
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
    filters.push(inArray(batches.status, params.statuses as BatchStatus[]));
  }
  if (params.createdSince !== undefined) {
    filters.push(gte(batches.createdAt, params.createdSince));
  }
  if (params.createdUntil !== undefined) {
    filters.push(lte(batches.createdAt, params.createdUntil));
  }
  const whereClause = filters.length > 0 ? and(...filters) : undefined;

  // Page rows + total count run in parallel — separate queries because
  // window aggregates would force a full table scan when the filter is
  // selective. count(*) on an indexed status+created_at query plan is
  // sub-ms even at 100k rows.
  const [rows, totalRows] = await Promise.all([
    db()
      .select({
        id: batches.id,
        operatorSlug: operators.slug,
        mode: batches.mode,
        status: batches.status,
        classificationStatus: batches.classificationStatus,
        declarationStatus: batches.declarationStatus,
        rowCount: batches.rowCount,
        createdAt: batches.createdAt,
        startedAt: batches.startedAt,
        completedAt: batches.completedAt,
        error: batches.error,
      })
      .from(batches)
      .leftJoin(operators, eq(batches.operatorId, operators.id))
      .where(whereClause)
      .orderBy(desc(batches.createdAt))
      .limit(params.limit)
      .offset(params.offset),
    db()
      .select({ n: sql<number>`count(*)::int` })
      .from(batches)
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
