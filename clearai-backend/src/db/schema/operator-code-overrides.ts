 
import { pgTable, varchar, char, index, uuid, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const operatorCodeOverrides = pgTable(
  'operator_code_overrides',
  {
    /** UUID PK — opaque per-row identity (UUIDv7 from src/util/uuid.ts on INSERT). */
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),

    /** Lowercase ASCII operator slug, e.g. "naqel", "aramex", "dhl". */
    operatorSlug: varchar('operator_slug', { length: 32 }).notNull(),
    /**
     * Merchant-supplied code as it arrived in the invoice (digits only,
     * 4–14 chars). Intentionally NOT FK to hs_codes — the whole point of
     * the table is to handle inputs that are not in the catalog.
     */
    sourceCode: varchar('source_code', { length: 14 }).notNull(),
    /**
     * Tenant's canonical 12-digit ZATCA target. FK to hs_codes(code)
     * with ON DELETE RESTRICT (a SABER deletion of an active override
     * target fails loudly so the operator has to re-curate first).
     */
    targetCode: char('target_code', { length: 12 }).notNull(),
  },
  (t) => ({
    /** Natural key — one rule per (operator, source) combination. */
    naturalKey: unique('operator_code_overrides_tenant_source_uniq').on(t.operatorSlug, t.sourceCode),
    targetIdx: index('operator_code_overrides_target_idx').on(t.targetCode),
  }),
);

export type TenantCodeOverride = typeof operatorCodeOverrides.$inferSelect;
export type NewTenantCodeOverride = typeof operatorCodeOverrides.$inferInsert;
