/**
 * tenant_lookups — per-tenant value-translation rows.
 *
 * Single wide table keyed on (tenant, lookup_type, source_value); one row
 * per translation. Naqel's six mapping sheets (CityMaping, Tabdul City,
 * CurrencyMapping, SourceCompanyPortMaping, Tabadul CountryCode,
 * CountryOfOriginClientMapping) all land here under different lookup_types.
 *
 * Hot-path read: given (tenant, lookup_type, source_value), return
 * canonical_value. Covered by the natural-key UNIQUE.
 *
 * Related tables:
 *   • tenants               — FK target (tenant -> tenants.slug)
 *   • tenant_field_mappings — selects WHICH source column produces source_value
 */
import { pgTable, uuid, varchar, text, jsonb, foreignKey, index, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from './tenants.js';

export const tenantLookups = pgTable(
  'tenant_lookups',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),

    /** Owning tenant slug. FK -> tenants(slug) ON DELETE RESTRICT. */
    tenant: varchar('tenant', { length: 32 }).notNull(),

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
    tenantFk: foreignKey({
      name: 'tenant_lookups_tenant_fk',
      columns: [t.tenant],
      foreignColumns: [tenants.slug],
    }).onDelete('restrict'),

    naturalUniq: unique('tenant_lookups_natural_uniq').on(t.tenant, t.lookupType, t.sourceValue),

    tenantTypeIdx: index('tenant_lookups_tenant_type_idx').on(t.tenant, t.lookupType),
  }),
);

export type TenantLookupRow = typeof tenantLookups.$inferSelect;
export type NewTenantLookupRow = typeof tenantLookups.$inferInsert;
