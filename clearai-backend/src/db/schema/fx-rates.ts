/**
 * fx_rates — manual-seed currency conversion table.
 *
 * ZATCA accepts only SAR-denominated invoices, so every merchant value in
 * a foreign currency is converted to SAR at parse time. This table is the
 * authoritative source of rates; the parse stage looks up the most recent
 * row at-or-before the batch upload date.
 *
 * See migration 0076_fx_rates.sql for the CHECK constraints and seed data.
 */
import { pgTable, uuid, varchar, numeric, date, text, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const fxRates = pgTable(
  'fx_rates',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    /** Always 'SAR' in V1; CHECK enforced at DB. */
    baseCurrency: varchar('base_currency', { length: 3 }).notNull().default('SAR'),
    /** ISO 4217 3-letter, uppercase. CHECK ~ '^[A-Z]{3}$' at DB. */
    quoteCurrency: varchar('quote_currency', { length: 3 }).notNull(),
    /** Units of base per 1 quote. e.g. 1 USD -> 3.75 SAR. */
    rate: numeric('rate', { precision: 18, scale: 8 }).notNull(),
    /** Calendar date this rate is valid for (Asia/Riyadh). */
    asOfDate: date('as_of_date').notNull(),
    /** 'manual_seed' in V1; future 'sama_daily' | 'ecb' | 'frozen_batch'. */
    source: varchar('source', { length: 32 }).notNull().default('manual_seed'),
    /** Free-form ops note. */
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    naturalUniq: unique('fx_rates_natural_uniq').on(t.quoteCurrency, t.asOfDate),
    quoteDateIdx: index('fx_rates_quote_date_idx').on(t.quoteCurrency, t.asOfDate),
  }),
);

export type FxRateRow = typeof fxRates.$inferSelect;
export type NewFxRateRow = typeof fxRates.$inferInsert;
