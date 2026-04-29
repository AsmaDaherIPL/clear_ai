/**
 * `procedure_codes` — lookup for ZATCA "import/export procedures" codes
 * referenced by `hs_codes.procedures` (a comma-separated string like
 * "2,28,61"). Sourced from the official ZATCA دليل رموز إجراءات فسح
 * وتصدير السلع — ~111 codes, Arabic-only descriptions, codes 1–113 with
 * gaps (some codes were removed entirely in past revisions).
 *
 * `is_repealed` materialises the `(ملغي)` marker baked into ~25 of the
 * descriptions — the description text keeps the suffix verbatim (it's
 * part of the official text), but consumers can filter by the boolean
 * for fast lookups when rendering current-vs-historical procedures.
 *
 * Codes are stored as varchar(8) (not int) so future ZATCA revisions
 * with sub-codes ("23a") or zero-padded codes don't require a migration.
 */
import { pgTable, varchar, text, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const procedureCodes = pgTable(
  'procedure_codes',
  {
    code: varchar('code', { length: 8 }).primaryKey(),
    descriptionAr: text('description_ar').notNull(),
    isRepealed: boolean('is_repealed').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Partial index — only-current codes are the hot path for response
    // assembly; repealed codes are surfaced for trace replay only.
    repealedIdx: index('procedure_codes_repealed_idx')
      .on(t.isRepealed)
      .where(sql`${t.isRepealed} = false`),
  }),
);

export type ProcedureCodeRow = typeof procedureCodes.$inferSelect;
export type NewProcedureCodeRow = typeof procedureCodes.$inferInsert;
