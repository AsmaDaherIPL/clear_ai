/**
 * operator_lookups — per-operator value-translation rows.
 *
 * Holds operator-SPECIFIC translations only. Universal Tabadul reference
 * data (currency, country, city, port, customs_gate, uom) lives in the
 * standalone `tabadul_codes` table. The naming convention here remains
 * (lookup_type, source_value, canonical_value) so the renderer treats
 * both tables identically at the read site.
 *
 * Operator-specific types currently in use:
 *   • client_country         — ClientID -> default Countryoforigin
 *   • client_source_company  — `${ClientID}:${CustRegPortCode}` -> SourceCompanyNo
 *                              (metadata: { sourceCompanyName, custRegPortCode })
 *   • destination_station    — InfoCityId -> TabdulCityId
 *
 * Hot-path read: given (operator_id, lookup_type, source_value), return
 * canonical_value. Covered by the natural-key UNIQUE.
 *
 * Related tables:
 *   • operators              — FK target (operator_id -> operators.id)
 *   • operator_field_mappings — selects WHICH source column produces source_value
 *   • tabadul_codes          — universal Tabadul reference data
 */
import { pgTable, uuid, varchar, text, jsonb, foreignKey, index, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { operators } from './operators.js';

export const operatorLookups = pgTable(
  'operator_lookups',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),

    /** Owning operator id. FK -> operators(id) ON DELETE RESTRICT. */
    operatorId: uuid('operator_id').notNull(),

    /** snake_case category; format-CHECKed at the DB. */
    lookupType: varchar('lookup_type', { length: 64 }).notNull(),

    /** Verbatim source value (trimmed only, not case-folded). */
    sourceValue: text('source_value').notNull(),

    /** What the rest of ClearAI uses (operator-specific canonical value). */
    canonicalValue: text('canonical_value').notNull(),

    /** Optional extras; CHECK enforces jsonb_typeof = 'object'. */
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`).$type<Record<string, unknown>>(),
  },
  (t) => ({
    operatorIdFk: foreignKey({
      name: 'operator_lookups_operator_id_fk',
      columns: [t.operatorId],
      foreignColumns: [operators.id],
    }).onDelete('restrict'),

    naturalUniq: unique('operator_lookups_natural_uniq').on(t.operatorId, t.lookupType, t.sourceValue),

    operatorTypeIdx: index('operator_lookups_operator_id_type_idx').on(t.operatorId, t.lookupType),
  }),
);

export type OperatorLookupRow = typeof operatorLookups.$inferSelect;
export type NewOperatorLookupRow = typeof operatorLookups.$inferInsert;
