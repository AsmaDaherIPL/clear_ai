
import { pgTable, varchar, char, index, uuid, foreignKey, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { operators } from './operators.js';

export const operatorCodeOverrides = pgTable(
  'operator_code_overrides',
  {
    /** UUID PK — opaque per-row identity (UUIDv7 from src/util/uuid.ts on INSERT). */
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),

    /** Owning operator id. FK -> operators(id) ON DELETE RESTRICT. */
    operatorId: uuid('operator_id').notNull(),
    /**
     * Merchant-supplied code as it arrived in the invoice (digits only,
     * 4–14 chars). Intentionally NOT FK to hs_codes — the whole point of
     * the table is to handle inputs that are not in the catalog.
     */
    sourceCode: varchar('source_code', { length: 14 }).notNull(),
    /**
     * Canonical 12-digit ZATCA target. FK to hs_codes(code) with
     * ON DELETE RESTRICT (a SABER deletion of an active override target
     * fails loudly so the operator has to re-curate first).
     */
    targetCode: char('target_code', { length: 12 }).notNull(),
  },
  (t) => ({
    operatorIdFk: foreignKey({
      name: 'operator_code_overrides_operator_id_fk',
      columns: [t.operatorId],
      foreignColumns: [operators.id],
    }).onDelete('restrict'),

    /** Natural key — one rule per (operator, source) combination. */
    naturalKey: unique('operator_code_overrides_operator_id_source_uniq').on(t.operatorId, t.sourceCode),
    targetIdx: index('operator_code_overrides_target_idx').on(t.targetCode),
  }),
);

export type OperatorCodeOverrideRow = typeof operatorCodeOverrides.$inferSelect;
export type NewOperatorCodeOverrideRow = typeof operatorCodeOverrides.$inferInsert;
