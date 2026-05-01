/** procedure_codes — ZATCA import/export procedure lookup (Arabic-only). */
import { pgTable, varchar, text, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const procedureCodes = pgTable(
  'procedure_codes',
  {
    code: varchar('code', { length: 8 }).primaryKey(),
    descriptionAr: text('description_ar').notNull(),
    /** Mirrors the `(ملغي)` marker so consumers can filter active codes. */
    isRepealed: boolean('is_repealed').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Partial index over active codes (the response-assembly hot path).
    repealedIdx: index('procedure_codes_repealed_idx')
      .on(t.isRepealed)
      .where(sql`${t.isRepealed} = false`),
  }),
);

export type ProcedureCodeRow = typeof procedureCodes.$inferSelect;
export type NewProcedureCodeRow = typeof procedureCodes.$inferInsert;
