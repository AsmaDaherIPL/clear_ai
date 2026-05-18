/**
 * manifests — one row per MAWB (master airwaybill).
 *
 * Introduced in migration 0085 (PR2) to mirror the ZATCA customs data
 * model: one NQM contains many AWBs; each AWB produces one NQD; each NQD
 * carries many line items.
 *
 * Two ingest patterns:
 *   • Carrier-supplied manifest — `mawb_no` is the real master AWB number,
 *     `manifested_at` is the carrier's timestamp.
 *   • CSV upload without manifest metadata — the parser synthesises an
 *     `mawb_no` of the form '{operator_slug}_m_{seqno}' (seqno scoped per
 *     batch, starting at 1). `manifested_at` is NULL in that case.
 *
 * One manifest belongs to exactly one batch. A batch can contain many
 * manifests (a single CSV upload may span multiple MAWBs).
 *
 * Related tables:
 *   • batches  — FK target (batch_id -> batches.id) ON DELETE CASCADE
 *   • awbs     — child rows (FK ON DELETE CASCADE)
 *   • batch_filings.manifest_id — backreference, NULLABLE
 */
import { pgTable, uuid, text, date, timestamp, foreignKey, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { batches } from './batches.js';

export const manifests = pgTable(
  'manifests',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),

    /** Parent batch. FK -> batches(id) ON DELETE CASCADE. */
    batchId: uuid('batch_id').notNull(),

    /**
     * Carrier-supplied master AWB number, or a synthesised id of the form
     * '{operator_slug}_m_{seqno}' when the source data has no manifest
     * timestamp. Stored as text because Naqel occasionally uses
     * non-numeric identifiers.
     */
    mawbNo: text('mawb_no').notNull(),

    /**
     * Carrier-supplied manifest timestamp. NULL when synthesised — the
     * mawb_no is then the only handle on this manifest.
     */
    manifestedAt: timestamp('manifested_at', { withTimezone: true }),

    /** Optional flight/voyage metadata; freeform text. */
    flightNo: text('flight_no'),
    arrivalDate: date('arrival_date'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    batchFk: foreignKey({
      name: 'manifests_batch_id_fk',
      columns: [t.batchId],
      foreignColumns: [batches.id],
    }).onDelete('cascade'),

    batchIdx: index('manifests_batch_id_idx').on(t.batchId),
    batchMawbUniq: uniqueIndex('manifests_batch_mawb_uniq').on(t.batchId, t.mawbNo),

    mawbNonempty: check('manifests_mawb_no_nonempty_chk', sql`length(${t.mawbNo}) > 0`),
  }),
);

export type ManifestRow = typeof manifests.$inferSelect;
export type NewManifestRow = typeof manifests.$inferInsert;
