/**
 * operator_field_mappings — per-operator column-mapping rules.
 *
 * One row per (operator, canonical_field). Drives the single generic mapper
 * at src/modules/operators/operator-line-item.mapper.ts. There are NO per-operator
 * TypeScript files; onboarding a new carrier is rows in this table.
 *
 * Related tables:
 *   • tenants               — FK target (operator -> operators.slug)
 *   • operator_constants      — fixed values that don't come from the source file
 *   • operator_lookups        — value-translation tables (city, currency, ...)
 *
 * The closed enum for `transform` mirrors TransformKind in
 * src/modules/operators/operator-config.types.ts.
 */
import { pgTable, uuid, varchar, text, boolean, foreignKey, index, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { operators } from './operators.js';

export const operatorFieldMappings = pgTable(
  'operator_field_mappings',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),

    /** Owning operator_slug. FK -> operators(slug) ON DELETE RESTRICT. */
    operatorSlug: varchar('operator_slug', { length: 32 }).notNull(),

    /** Verbatim header from the operator's source file (case-sensitive). */
    sourceColumn: text('source_column').notNull(),

    /** CanonicalLineItem field this column feeds; validated at registry load. */
    canonicalField: varchar('canonical_field', { length: 64 }).notNull(),

    /** Required cells trigger RequiredFieldMissingError when empty. */
    required: boolean('required').notNull().default(false),

    /** Optional transform; closed enum mirrors TransformKind. NULL = none. */
    transform: varchar('transform', { length: 16 }),

    /** Substituted when source cell is empty AND required=false. */
    defaultValue: text('default_value'),

    /**
     * Fallback header chain. The mapper reads `sourceColumn` first; if that
     * cell is empty, it tries each entry in `fallbackColumns` in order and
     * takes the first non-empty value. Used when one operator ships multiple
     * xlsx variants — e.g. Naqel's 'ConsigneeName' (light-example) vs
     * 'Consignee' (alt sample).
     */
    fallbackColumns: text('fallback_columns')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`)
      .$type<string[]>(),
  },
  (t) => ({
    operatorSlugFk: foreignKey({
      name: 'operator_field_mappings_operator_slug_fk',
      columns: [t.operatorSlug],
      foreignColumns: [operators.slug],
    }).onDelete('restrict'),

    tenantCanonicalUniq: unique('operator_field_mappings_tenant_canonical_uniq').on(
      t.operatorSlug,
      t.canonicalField,
    ),

    operatorSlugIdx: index('operator_field_mappings_operator_slug_idx').on(t.operatorSlug),
  }),
);

export type OperatorFieldMappingRow = typeof operatorFieldMappings.$inferSelect;
export type NewOperatorFieldMappingRow = typeof operatorFieldMappings.$inferInsert;
