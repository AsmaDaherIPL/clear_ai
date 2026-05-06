/**
 * operator_lookups — per-operator value-translation rows.
 *
 * Single wide table keyed on (operator, lookup_type, source_value); one row
 * per translation. Naqel's six mapping sheets (CityMaping, Tabdul City,
 * CurrencyMapping, SourceCompanyPortMaping, Tabadul CountryCode,
 * CountryOfOriginClientMapping) all land here under different lookup_types.
 *
 * Hot-path read: given (operator, lookup_type, source_value), return
 * canonical_value. Covered by the natural-key UNIQUE.
 *
 * Related tables:
 *   • tenants               — FK target (operator -> operators.slug)
 *   • operator_field_mappings — selects WHICH source column produces source_value
 */
import { pgTable, uuid, varchar, text, jsonb, foreignKey, index, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { operators } from './operators.js';

export const operatorLookups = pgTable(
  'operator_lookups',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),

    /** Owning operator_slug. FK -> operators(slug) ON DELETE RESTRICT. */
    operatorSlug: varchar('operator_slug', { length: 32 }).notNull(),

    /** snake_case category; format-CHECKed at the DB. */
    lookupType: varchar('lookup_type', { length: 64 }).notNull(),

    /** Verbatim source value (trimmed only, not case-folded). */
    sourceValue: text('source_value').notNull(),

    /** What the rest of ClearAI uses (ISO-3166, ISO-4217, ZATCA port, etc.). */
    canonicalValue: text('canonical_value').notNull(),

    /** Optional extras; CHECK enforces jsonb_typeof = 'object'. */
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`).$type<Record<string, unknown>>(),
  },
  (t) => ({
    operatorSlugFk: foreignKey({
      name: 'operator_lookups_operator_slug_fk',
      columns: [t.operatorSlug],
      foreignColumns: [operators.slug],
    }).onDelete('restrict'),

    naturalUniq: unique('operator_lookups_natural_uniq').on(t.operatorSlug, t.lookupType, t.sourceValue),

    tenantTypeIdx: index('operator_lookups_operator_slug_type_idx').on(t.operatorSlug, t.lookupType),
  }),
);

export type OperatorLookupRow = typeof operatorLookups.$inferSelect;
export type NewOperatorLookupRow = typeof operatorLookups.$inferInsert;
