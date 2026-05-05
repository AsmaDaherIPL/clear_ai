/**
 * tenant_field_mappings — per-tenant column-mapping rules.
 *
 * One row per (tenant, canonical_field). Drives the single generic mapper
 * at src/modules/tenants/tenant-line-item.mapper.ts. There are NO per-tenant
 * TypeScript files; onboarding a new carrier is rows in this table.
 *
 * Related tables:
 *   • tenants               — FK target (tenant -> tenants.slug)
 *   • tenant_constants      — fixed values that don't come from the source file
 *   • tenant_lookups        — value-translation tables (city, currency, ...)
 *
 * The closed enum for `transform` mirrors TransformKind in
 * src/modules/tenants/tenant-config.types.ts.
 */
import { pgTable, uuid, varchar, text, boolean, foreignKey, index, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from './tenants.js';

export const tenantFieldMappings = pgTable(
  'tenant_field_mappings',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),

    /** Owning tenant slug. FK -> tenants(slug) ON DELETE RESTRICT. */
    tenant: varchar('tenant', { length: 32 }).notNull(),

    /** Verbatim header from the tenant's source file (case-sensitive). */
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
     * takes the first non-empty value. Used when one tenant ships multiple
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
    tenantFk: foreignKey({
      name: 'tenant_field_mappings_tenant_fk',
      columns: [t.tenant],
      foreignColumns: [tenants.slug],
    }).onDelete('restrict'),

    tenantCanonicalUniq: unique('tenant_field_mappings_tenant_canonical_uniq').on(
      t.tenant,
      t.canonicalField,
    ),

    tenantIdx: index('tenant_field_mappings_tenant_idx').on(t.tenant),
  }),
);

export type TenantFieldMappingRow = typeof tenantFieldMappings.$inferSelect;
export type NewTenantFieldMappingRow = typeof tenantFieldMappings.$inferInsert;
