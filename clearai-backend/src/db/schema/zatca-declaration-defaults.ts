/**
 * zatca_declaration_defaults — ZATCA-spec defaults for the saudiEDI envelope.
 *
 * These values are determined by the ZATCA Declaration spec, not by which
 * operator is filing. Every broker submitting through Tabadul uses the
 * same values for these envelope slots:
 *
 *   declaration_type, final_country, inspection_group_id, payment_method,
 *   invoice_seq_no, invoice_type_id, invoice_payment_method_id,
 *   payment_document_status_id, deal_value, item_unit_per_packages,
 *   item_duty_type_id, express_transport_type, express_add_country_code,
 *   express_country
 *
 * Read once at boot via zatca-defaults.repository (cached). The renderer
 * reads from there instead of the previous operator_constants lookups.
 */
import { pgTable, uuid, varchar, text, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const zatcaDeclarationDefaults = pgTable(
  'zatca_declaration_defaults',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    /** snake_case key, format-CHECKed at the DB. */
    key: varchar('key', { length: 64 }).notNull(),
    /** Free-form text value; the renderer is responsible for parsing. */
    value: text('value').notNull(),
  },
  (t) => ({
    keyUniq: unique('zatca_declaration_defaults_key_uniq').on(t.key),
  }),
);

export type ZatcaDeclarationDefaultRow = typeof zatcaDeclarationDefaults.$inferSelect;
export type NewZatcaDeclarationDefaultRow = typeof zatcaDeclarationDefaults.$inferInsert;
