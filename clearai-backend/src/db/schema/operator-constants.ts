/**
 * operator_constants — per-operator key/value constants for the ZATCA
 * Declaration template renderer and other operator-driven static config.
 *
 * One row per (operator, key). Keys are snake_case, format-CHECKed at the DB.
 * Values are free-form text; the renderer is responsible for any parsing.
 *
 * Related tables:
 *   • tenants               — FK target (operator -> operators.slug)
 *   • operator_field_mappings — column rules (this table is for fixed values
 *                             that don't come from the source file at all)
 */
import { pgTable, uuid, varchar, text, foreignKey, index, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { operators } from './operators.js';

export const operatorConstants = pgTable(
  'operator_constants',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),

    /** Owning operator_slug. FK -> operators(slug) ON DELETE RESTRICT. */
    operatorSlug: varchar('operator_slug', { length: 32 }).notNull(),

    /** snake_case key, format-CHECKed at the DB. */
    key: varchar('key', { length: 64 }).notNull(),

    /** Free-form text value. */
    value: text('value').notNull(),
  },
  (t) => ({
    operatorSlugFk: foreignKey({
      name: 'operator_constants_operator_slug_fk',
      columns: [t.operatorSlug],
      foreignColumns: [operators.slug],
    }).onDelete('restrict'),

    tenantKeyUniq: unique('operator_constants_tenant_key_uniq').on(t.operatorSlug, t.key),

    operatorSlugIdx: index('operator_constants_operator_slug_idx').on(t.operatorSlug),
  }),
);

export type OperatorConstantRow = typeof operatorConstants.$inferSelect;
export type NewOperatorConstantRow = typeof operatorConstants.$inferInsert;
