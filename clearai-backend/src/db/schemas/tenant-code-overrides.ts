/**
 * tenant_code_overrides — per-tenant rewrite rules from the messy input
 * we receive (often non-ZATCA codes from merchant invoices) to canonical
 * 12-digit ZATCA targets.
 *
 * Renamed from broker_code_mapping in 0026_tenant_code_overrides.sql.
 * See ADR-0025 for the rationale (~56% of rows translate codes that are
 * not in the ZATCA catalog at all, ~36% override valid codes to a
 * tenant-preferred canonical form).
 *
 * Multi-tenant from day 1 — `tenant` has NO DEFAULT; ingest scripts must
 * specify which tenant's xlsx they parsed.
 */
import { pgTable, varchar, char, primaryKey, index } from 'drizzle-orm/pg-core';

export const tenantCodeOverrides = pgTable(
  'tenant_code_overrides',
  {
    /** Lowercase ASCII tenant slug, e.g. "naqel", "aramex", "dhl". */
    tenant: varchar('tenant', { length: 32 }).notNull(),
    /**
     * Merchant-supplied code as it arrived in the invoice (digits only,
     * 4–14 chars). Intentionally NOT FK to hs_codes — the whole point of
     * the table is to handle inputs that are not in the catalog.
     */
    sourceCodeNorm: varchar('source_code_norm', { length: 14 }).notNull(),
    /**
     * Tenant's canonical 12-digit ZATCA target. FK to hs_codes(code)
     * with ON DELETE RESTRICT (a SABER deletion of an active override
     * target fails loudly so the tenant has to re-curate first).
     */
    targetCode: char('target_code', { length: 12 }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenant, t.sourceCodeNorm] }),
    targetIdx: index('tenant_code_overrides_target_idx').on(t.targetCode),
  }),
);

export type TenantCodeOverride = typeof tenantCodeOverrides.$inferSelect;
export type NewTenantCodeOverride = typeof tenantCodeOverrides.$inferInsert;
