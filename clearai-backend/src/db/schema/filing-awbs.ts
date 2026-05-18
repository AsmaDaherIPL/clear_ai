/**
 * filing_awbs — many-to-many join between batch_filings and awbs.
 *
 * Introduced in migration 0085 (PR2). Encodes "which AWBs are covered by
 * this filing":
 *   • HV filings (HV_STANDALONE): exactly one row in the join — one AWB
 *     per filing.
 *   • LV consolidated filings (LV_BUNDLED): many rows in the join —
 *     all AWBs that landed in the same ≤10,000-line-item chunk.
 *
 * `sequence` orders the AWBs within the filing so the rendered XML is
 * reproducible across re-runs. For HV filings sequence is always 0.
 *
 * Related tables:
 *   • batch_filings — FK target (filing_id -> batch_filings.id) ON DELETE CASCADE
 *   • awbs          — FK target (awb_id -> awbs.id) ON DELETE CASCADE
 */
import { pgTable, uuid, integer, timestamp, foreignKey, index, primaryKey, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { batchFilings } from './batch-filings.js';
import { awbs } from './awbs.js';

export const filingAwbs = pgTable(
  'filing_awbs',
  {
    filingId: uuid('filing_id').notNull(),
    awbId: uuid('awb_id').notNull(),

    /** 0-based position within the filing's render order. */
    sequence: integer('sequence').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ name: 'filing_awbs_pkey', columns: [t.filingId, t.awbId] }),

    filingFk: foreignKey({
      name: 'filing_awbs_filing_id_fk',
      columns: [t.filingId],
      foreignColumns: [batchFilings.id],
    }).onDelete('cascade'),

    awbFk: foreignKey({
      name: 'filing_awbs_awb_id_fk',
      columns: [t.awbId],
      foreignColumns: [awbs.id],
    }).onDelete('cascade'),

    awbIdx: index('filing_awbs_awb_id_idx').on(t.awbId),
    filingSequenceIdx: index('filing_awbs_filing_sequence_idx').on(t.filingId, t.sequence),

    sequenceNonneg: check('filing_awbs_sequence_nonneg_chk', sql`${t.sequence} >= 0`),
  }),
);

export type FilingAwbRow = typeof filingAwbs.$inferSelect;
export type NewFilingAwbRow = typeof filingAwbs.$inferInsert;
