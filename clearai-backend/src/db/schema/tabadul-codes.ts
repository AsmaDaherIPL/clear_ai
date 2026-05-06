/**
 * tabadul_codes — universal Tabadul reference data, operator-agnostic.
 *
 * Holds the rows that Tabadul publishes as authoritative for everyone:
 *   • currency_code      — ISO-4217 -> TabdulCurrencyId
 *   • country_of_origin  — ISO alpha-2 INTLCODE -> CountryCode
 *   • tabdul_city        — CITY_CD -> CITY_ARB_NAME (metadata: engName, intlCode, countryCode)
 *   • port               — Tabadul port code -> canonical port id
 *   • customs_gate       — Saudi customs-gate station code -> id
 *   • uom                — unit-of-measure code -> canonical
 *
 * Naming: `code_type` (mirrors the per-operator `lookup_type` keyword used
 * elsewhere in the codebase) keeps the read-site code uniform — callers can
 * iterate either table with the same shape.
 *
 * No operator FK. The renderer reads from BOTH tabadul_codes and
 * operator_lookups and merges them at request time.
 */
import { pgTable, uuid, varchar, text, jsonb, index, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const tabadulCodes = pgTable(
  'tabadul_codes',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),

    /** snake_case category; format-CHECKed at the DB. */
    codeType: varchar('code_type', { length: 64 }).notNull(),

    /** Verbatim source value (trimmed only, not case-folded). */
    sourceValue: text('source_value').notNull(),

    /** Canonical Tabadul-side value used in ZATCA envelopes. */
    canonicalValue: text('canonical_value').notNull(),

    /** Optional extras; CHECK enforces jsonb_typeof = 'object'. */
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`).$type<Record<string, unknown>>(),
  },
  (t) => ({
    naturalUniq: unique('tabadul_codes_natural_uniq').on(t.codeType, t.sourceValue),

    codeTypeIdx: index('tabadul_codes_code_type_idx').on(t.codeType),
  }),
);

export type TabadulCodeRow = typeof tabadulCodes.$inferSelect;
export type NewTabadulCodeRow = typeof tabadulCodes.$inferInsert;
