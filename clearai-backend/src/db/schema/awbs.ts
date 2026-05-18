/**
 * awbs — one row per HAWB (house airwaybill / individual waybill).
 *
 * Introduced in migration 0085 (PR2). An AWB represents one consignee
 * shipment: one AWB = one consignee = one ZATCA NQD declaration. Item
 * rows in `batch_items` reference this table via the (nullable in PR2)
 * `awb_id` FK.
 *
 * Consignee identity columns are nullable because Naqel's source CSV
 * occasionally omits fields like `ConsigneeNationalID`. National ID is
 * the canonical consignee key per the 2026-05-18 customs spec discussion.
 *
 * `invoice_value_sar` and `line_item_count` are populated by the bundler
 * (PR3). They drive the AWB-level HV/LV gate (>= 1000 SAR -> HV) and the
 * 10,000-line-item cap on LV consolidated declarations.
 *
 * Related tables:
 *   • manifests    — FK target (manifest_id -> manifests.id) ON DELETE CASCADE
 *   • batch_items  — referenced via batch_items.awb_id (NULLABLE) ON DELETE SET NULL
 *   • filing_awbs  — many-to-many join with batch_filings
 */
import { pgTable, uuid, text, date, timestamp, numeric, integer, foreignKey, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { manifests } from './manifests.js';

export const awbs = pgTable(
  'awbs',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),

    /** Parent manifest. FK -> manifests(id) ON DELETE CASCADE. */
    manifestId: uuid('manifest_id').notNull(),

    /**
     * Carrier-supplied house waybill number (Naqel's WayBillNo column).
     * Required because one AWB = one consignee shipment = one declaration.
     */
    awbNo: text('awb_no').notNull(),

    /**
     * Consignee identity. National ID is the canonical key per the
     * 2026-05-18 customs spec discussion; nullable because the source
     * CSV occasionally omits it.
     */
    consigneeNationalId: text('consignee_national_id'),
    consigneeName: text('consignee_name'),
    consigneeMobile: text('consignee_mobile'),
    consigneePhone: text('consignee_phone'),
    consigneeBirthDate: date('consignee_birth_date'),
    consigneeAddress: text('consignee_address'),
    consigneeDest: text('consignee_dest'),
    consigneeDestStation: text('consignee_dest_station'),

    /**
     * Aggregated invoice value for the AWB in SAR. Populated by the
     * bundler (PR3). The HV/LV gate (1000 SAR) is applied against this.
     * NULL until bundler runs.
     */
    invoiceValueSar: numeric('invoice_value_sar', { precision: 18, scale: 4 }),

    /**
     * Aggregated count of line items (= batch_items rows) under this AWB.
     * NULL until bundler runs.
     */
    lineItemCount: integer('line_item_count'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    manifestFk: foreignKey({
      name: 'awbs_manifest_id_fk',
      columns: [t.manifestId],
      foreignColumns: [manifests.id],
    }).onDelete('cascade'),

    manifestIdx: index('awbs_manifest_id_idx').on(t.manifestId),
    manifestAwbUniq: uniqueIndex('awbs_manifest_awb_uniq').on(t.manifestId, t.awbNo),
    consigneeNationalIdIdx: index('awbs_consignee_national_id_idx')
      .on(t.consigneeNationalId)
      .where(sql`${t.consigneeNationalId} IS NOT NULL`),

    awbNonempty: check('awbs_awb_no_nonempty_chk', sql`length(${t.awbNo}) > 0`),
    invoiceValueNonneg: check(
      'awbs_invoice_value_nonneg_chk',
      sql`${t.invoiceValueSar} IS NULL OR ${t.invoiceValueSar} >= 0`,
    ),
    lineItemCountNonneg: check(
      'awbs_line_item_count_nonneg_chk',
      sql`${t.lineItemCount} IS NULL OR ${t.lineItemCount} >= 0`,
    ),
  }),
);

export type AwbRow = typeof awbs.$inferSelect;
export type NewAwbRow = typeof awbs.$inferInsert;
