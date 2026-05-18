/**
 * Repository for manifests, awbs, and filing_awbs (PR3).
 *
 * Pure CRUD over the new entities; no business logic. The bundler and
 * the parser ingest use-case call these to read/write the hierarchy
 * created by PR2's migration 0085.
 *
 * Three conventions:
 *  - All writes accept a node-postgres PoolClient so callers can compose
 *    multi-table inserts in a single transaction (parser uses this to
 *    insert manifests + awbs + items atomically).
 *  - Reads use the default pool — no need for tx awareness.
 *  - List queries take a batchId / manifestId / awbId param; cross-batch
 *    scans are intentionally not exposed.
 */
import type { PoolClient } from 'pg';
import { getPool } from '../../db/client.js';
import type {
  AwbRow,
  ManifestRow,
  NewAwbRow,
  NewManifestRow,
  NewFilingAwbRow,
  FilingAwbRow,
} from '../../db/schema.js';

// ──────────────────────────────────────────────────────────────────────────
// Manifests
// ──────────────────────────────────────────────────────────────────────────

export interface InsertManifestInput {
  batchId: string;
  mawbNo: string;
  manifestedAt: Date | null;
  flightNo?: string | null;
  arrivalDate?: string | null;
}

/** Insert one manifest row, returning the persisted row (with id). */
export async function insertManifest(
  client: PoolClient,
  input: InsertManifestInput,
): Promise<ManifestRow> {
  const result = await client.query<ManifestRow>(
    `INSERT INTO manifests (batch_id, mawb_no, manifested_at, flight_no, arrival_date)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, batch_id AS "batchId", mawb_no AS "mawbNo",
               manifested_at AS "manifestedAt", flight_no AS "flightNo",
               arrival_date AS "arrivalDate",
               created_at AS "createdAt", updated_at AS "updatedAt"`,
    [
      input.batchId,
      input.mawbNo,
      input.manifestedAt,
      input.flightNo ?? null,
      input.arrivalDate ?? null,
    ],
  );
  return result.rows[0]!;
}

export async function listManifestsByBatch(batchId: string): Promise<ManifestRow[]> {
  const pool = getPool();
  const result = await pool.query<ManifestRow>(
    `SELECT id, batch_id AS "batchId", mawb_no AS "mawbNo",
            manifested_at AS "manifestedAt", flight_no AS "flightNo",
            arrival_date AS "arrivalDate",
            created_at AS "createdAt", updated_at AS "updatedAt"
       FROM manifests
      WHERE batch_id = $1
      ORDER BY manifested_at NULLS LAST, mawb_no`,
    [batchId],
  );
  return result.rows;
}

// ──────────────────────────────────────────────────────────────────────────
// AWBs
// ──────────────────────────────────────────────────────────────────────────

export interface InsertAwbInput {
  manifestId: string;
  awbNo: string;
  consigneeNationalId?: string | null;
  consigneeName?: string | null;
  consigneeMobile?: string | null;
  consigneePhone?: string | null;
  consigneeBirthDate?: string | null;
  consigneeAddress?: string | null;
  consigneeDest?: string | null;
  consigneeDestStation?: string | null;
}

export async function insertAwb(
  client: PoolClient,
  input: InsertAwbInput,
): Promise<AwbRow> {
  const result = await client.query<AwbRow>(
    `INSERT INTO awbs (
       manifest_id, awb_no,
       consignee_national_id, consignee_name, consignee_mobile,
       consignee_phone, consignee_birth_date, consignee_address,
       consignee_dest, consignee_dest_station
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, manifest_id AS "manifestId", awb_no AS "awbNo",
               consignee_national_id AS "consigneeNationalId",
               consignee_name AS "consigneeName",
               consignee_mobile AS "consigneeMobile",
               consignee_phone AS "consigneePhone",
               consignee_birth_date AS "consigneeBirthDate",
               consignee_address AS "consigneeAddress",
               consignee_dest AS "consigneeDest",
               consignee_dest_station AS "consigneeDestStation",
               invoice_value_sar AS "invoiceValueSar",
               line_item_count AS "lineItemCount",
               created_at AS "createdAt", updated_at AS "updatedAt"`,
    [
      input.manifestId,
      input.awbNo,
      input.consigneeNationalId ?? null,
      input.consigneeName ?? null,
      input.consigneeMobile ?? null,
      input.consigneePhone ?? null,
      input.consigneeBirthDate ?? null,
      input.consigneeAddress ?? null,
      input.consigneeDest ?? null,
      input.consigneeDestStation ?? null,
    ],
  );
  return result.rows[0]!;
}

/**
 * Recompute and persist `invoice_value_sar` + `line_item_count` for one
 * AWB by aggregating the batch_items rows. Called by the bundler (PR3)
 * before partitioning, and by tests. Returns the fresh aggregates.
 */
export async function aggregateAwbValueAndCount(
  awbId: string,
): Promise<{ invoiceValueSar: number; lineItemCount: number }> {
  const pool = getPool();
  const result = await pool.query<{ sum: string | null; cnt: string }>(
    `SELECT
       COALESCE(SUM(((canonical->>'valueAmountSar')::numeric)), 0)::text AS sum,
       COUNT(*)::text AS cnt
     FROM batch_items
     WHERE awb_id = $1
       AND excluded_from_xml = false`,
    [awbId],
  );
  const row = result.rows[0]!;
  const sum = Number(row.sum ?? '0');
  const cnt = Number(row.cnt);
  await pool.query(
    `UPDATE awbs SET invoice_value_sar = $2, line_item_count = $3, updated_at = now()
     WHERE id = $1`,
    [awbId, sum, cnt],
  );
  return { invoiceValueSar: sum, lineItemCount: cnt };
}

export async function listAwbsByManifest(manifestId: string): Promise<AwbRow[]> {
  const pool = getPool();
  const result = await pool.query<AwbRow>(
    `SELECT id, manifest_id AS "manifestId", awb_no AS "awbNo",
            consignee_national_id AS "consigneeNationalId",
            consignee_name AS "consigneeName",
            consignee_mobile AS "consigneeMobile",
            consignee_phone AS "consigneePhone",
            consignee_birth_date AS "consigneeBirthDate",
            consignee_address AS "consigneeAddress",
            consignee_dest AS "consigneeDest",
            consignee_dest_station AS "consigneeDestStation",
            invoice_value_sar AS "invoiceValueSar",
            line_item_count AS "lineItemCount",
            created_at AS "createdAt", updated_at AS "updatedAt"
       FROM awbs
      WHERE manifest_id = $1
      ORDER BY awb_no`,
    [manifestId],
  );
  return result.rows;
}

export async function listAwbsByBatch(batchId: string): Promise<AwbRow[]> {
  const pool = getPool();
  const result = await pool.query<AwbRow>(
    `SELECT a.id, a.manifest_id AS "manifestId", a.awb_no AS "awbNo",
            a.consignee_national_id AS "consigneeNationalId",
            a.consignee_name AS "consigneeName",
            a.consignee_mobile AS "consigneeMobile",
            a.consignee_phone AS "consigneePhone",
            a.consignee_birth_date AS "consigneeBirthDate",
            a.consignee_address AS "consigneeAddress",
            a.consignee_dest AS "consigneeDest",
            a.consignee_dest_station AS "consigneeDestStation",
            a.invoice_value_sar AS "invoiceValueSar",
            a.line_item_count AS "lineItemCount",
            a.created_at AS "createdAt", a.updated_at AS "updatedAt"
       FROM awbs a
       JOIN manifests m ON m.id = a.manifest_id
      WHERE m.batch_id = $1
      ORDER BY m.mawb_no, a.awb_no`,
    [batchId],
  );
  return result.rows;
}

// ──────────────────────────────────────────────────────────────────────────
// Filing-AWB join
// ──────────────────────────────────────────────────────────────────────────

export async function insertFilingAwb(
  client: PoolClient,
  input: NewFilingAwbRow,
): Promise<FilingAwbRow> {
  const result = await client.query<FilingAwbRow>(
    `INSERT INTO filing_awbs (filing_id, awb_id, sequence)
     VALUES ($1, $2, $3)
     RETURNING filing_id AS "filingId", awb_id AS "awbId",
               sequence, created_at AS "createdAt"`,
    [input.filingId, input.awbId, input.sequence],
  );
  return result.rows[0]!;
}

export async function listFilingAwbsByFiling(filingId: string): Promise<FilingAwbRow[]> {
  const pool = getPool();
  const result = await pool.query<FilingAwbRow>(
    `SELECT filing_id AS "filingId", awb_id AS "awbId",
            sequence, created_at AS "createdAt"
       FROM filing_awbs
      WHERE filing_id = $1
      ORDER BY sequence`,
    [filingId],
  );
  return result.rows;
}

// Re-export NewManifestRow / NewAwbRow for callers that want the bare
// insertable shapes (e.g. the parser when it pre-builds entities before
// commit).
export type { NewManifestRow, NewAwbRow };
