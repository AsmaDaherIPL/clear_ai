/**
 * tenant_constants — per-tenant key/value constants for the ZATCA
 * Declaration template renderer and other tenant-driven static config.
 *
 * One row per (tenant, key). Keys are snake_case, format-CHECKed at the DB.
 * Values are free-form text; the renderer is responsible for any parsing.
 *
 * Related tables:
 *   • tenants               — FK target (tenant -> tenants.slug)
 *   • tenant_field_mappings — column rules (this table is for fixed values
 *                             that don't come from the source file at all)
 */
import { pgTable, uuid, varchar, text, foreignKey, index, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from './tenants.js';

export const tenantConstants = pgTable(
  'tenant_constants',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),

    /** Owning tenant slug. FK -> tenants(slug) ON DELETE RESTRICT. */
    tenant: varchar('tenant', { length: 32 }).notNull(),

    /** snake_case key, format-CHECKed at the DB. */
    key: varchar('key', { length: 64 }).notNull(),

    /** Free-form text value. */
    value: text('value').notNull(),
  },
  (t) => ({
    tenantFk: foreignKey({
      name: 'tenant_constants_tenant_fk',
      columns: [t.tenant],
      foreignColumns: [tenants.slug],
    }).onDelete('restrict'),

    tenantKeyUniq: unique('tenant_constants_tenant_key_uniq').on(t.tenant, t.key),

    tenantIdx: index('tenant_constants_tenant_idx').on(t.tenant),
  }),
);

export type TenantConstantRow = typeof tenantConstants.$inferSelect;
export type NewTenantConstantRow = typeof tenantConstants.$inferInsert;
