/**
 * Read-side HTTP handlers for the manifest/AWB/item hierarchy (PR3).
 *
 *   GET /batches/:id/manifests
 *   GET /manifests/:id/awbs
 *   GET /awbs/:id/items
 *
 * Pure projections over the DB. No mutation, no LLM, no blob I/O.
 * Wire field names are snake_case (consistent with the rest of the
 * backend's JSON conventions).
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getPool } from '../../db/client.js';
import {
  listAwbsByManifest,
  listManifestsByBatch,
} from './manifest.repository.js';

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-7][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}

// ─────────────────────────────────────────────────────────────────────────
// GET /batches/:id/manifests
// ─────────────────────────────────────────────────────────────────────────

export async function handleListManifestsByBatch(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<unknown> {
  const id = req.params.id;
  if (!isUuid(id)) return reply.code(400).send({ error: { code: 'invalid_id', message: 'batch id must be a UUID' } });

  // Verify the batch exists. 404 instead of 200-with-empty so the SPA
  // can distinguish "bad batch id" from "valid batch with no manifests
  // yet" (the latter returns 200 with manifests=[]).
  const pool = getPool();
  const exists = await pool.query<{ id: string }>(`SELECT id FROM batches WHERE id = $1`, [id]);
  if (exists.rowCount === 0) {
    return reply.code(404).send({ error: { code: 'batch_not_found', message: `batch ${id} not found` } });
  }

  const manifests = await listManifestsByBatch(id);
  return reply.send({
    batch_id: id,
    manifests: manifests.map((m) => ({
      id: m.id,
      mawb_no: m.mawbNo,
      manifested_at: m.manifestedAt ? m.manifestedAt.toISOString() : null,
      flight_no: m.flightNo,
      arrival_date: m.arrivalDate,
    })),
  });
}

// ─────────────────────────────────────────────────────────────────────────
// GET /manifests/:id/awbs
// ─────────────────────────────────────────────────────────────────────────

export async function handleListAwbsByManifest(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<unknown> {
  const id = req.params.id;
  if (!isUuid(id)) return reply.code(400).send({ error: { code: 'invalid_id', message: 'manifest id must be a UUID' } });

  const pool = getPool();
  const exists = await pool.query<{ id: string }>(`SELECT id FROM manifests WHERE id = $1`, [id]);
  if (exists.rowCount === 0) {
    return reply.code(404).send({ error: { code: 'manifest_not_found', message: `manifest ${id} not found` } });
  }

  const awbs = await listAwbsByManifest(id);
  return reply.send({
    manifest_id: id,
    awbs: awbs.map((a) => ({
      id: a.id,
      awb_no: a.awbNo,
      consignee_national_id: a.consigneeNationalId,
      consignee_name: a.consigneeName,
      consignee_mobile: a.consigneeMobile,
      consignee_phone: a.consigneePhone,
      consignee_birth_date: a.consigneeBirthDate,
      consignee_dest: a.consigneeDest,
      consignee_dest_station: a.consigneeDestStation,
      invoice_value_sar: a.invoiceValueSar,
      line_item_count: a.lineItemCount,
    })),
  });
}

// ─────────────────────────────────────────────────────────────────────────
// GET /awbs/:id/items
// ─────────────────────────────────────────────────────────────────────────

interface ItemListRow {
  id: string;
  row_index: number;
  status: string;
  final_code: string | null;
  goods_description_ar: string | null;
  description: string | null;
  value_amount: number | null;
  currency_code: string | null;
}

export async function handleListItemsByAwb(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<unknown> {
  const id = req.params.id;
  if (!isUuid(id)) return reply.code(400).send({ error: { code: 'invalid_id', message: 'awb id must be a UUID' } });

  const pool = getPool();
  const exists = await pool.query<{ id: string }>(`SELECT id FROM awbs WHERE id = $1`, [id]);
  if (exists.rowCount === 0) {
    return reply.code(404).send({ error: { code: 'awb_not_found', message: `awb ${id} not found` } });
  }

  // Light projection — full item detail lives on /batches/:id/items.
  // The per-AWB list is for the hierarchy navigator only; deep links
  // go through the existing item endpoint.
  const rows = await pool.query<ItemListRow>(
    `SELECT
       id, row_index,
       status,
       final_code,
       goods_description_ar,
       canonical->>'description' AS description,
       (canonical->>'valueAmount')::numeric AS value_amount,
       canonical->>'currencyCode' AS currency_code
     FROM batch_items
     WHERE awb_id = $1
     ORDER BY row_index`,
    [id],
  );

  return reply.send({
    awb_id: id,
    items: rows.rows.map((r) => ({
      id: r.id,
      row_index: r.row_index,
      status: r.status,
      final_code: r.final_code,
      goods_description_ar: r.goods_description_ar,
      description: r.description,
      value_amount: r.value_amount === null ? null : Number(r.value_amount),
      currency_code: r.currency_code,
    })),
  });
}
