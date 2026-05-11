/**
 * Single per-operator config row holding every render default the ZATCA
 * declaration template needs: submitter credentials, envelope constants,
 * and the consignee-address fallback. Replaces the global
 * zatca_declaration_defaults table and the per-operator zatca_* +
 * default_consignee_address columns dropped in 0063.
 */
import { pgTable, uuid, varchar, smallint, text, timestamp, boolean } from 'drizzle-orm/pg-core';
import { operators } from './operators.js';

export const operatorDeclarationConfig = pgTable('operator_declaration_config', {
  operatorId: uuid('operator_id')
    .primaryKey()
    .references(() => operators.id, { onDelete: 'cascade' }),

  zatcaSubmitterCarrierId: varchar('zatca_submitter_carrier_id', { length: 32 }),
  zatcaSubmitterName: text('zatca_submitter_name'),
  zatcaDeclarationNamespace: text('zatca_declaration_namespace'),

  declarationType: smallint('declaration_type').notNull().default(2),
  finalCountry: varchar('final_country', { length: 8 }).notNull().default('SA'),
  inspectionGroupId: smallint('inspection_group_id').notNull().default(10),
  paymentMethod: smallint('payment_method').notNull().default(1),
  invoiceSeqNo: smallint('invoice_seq_no').notNull().default(1),
  invoiceTypeId: smallint('invoice_type_id').notNull().default(5),
  invoicePaymentMethodId: smallint('invoice_payment_method_id').notNull().default(1),
  paymentDocumentStatusId: smallint('payment_document_status_id').notNull().default(0),
  dealValue: smallint('deal_value').notNull().default(1),
  itemUnitPerPackages: smallint('item_unit_per_packages').notNull().default(1),
  itemDutyTypeId: smallint('item_duty_type_id').notNull().default(1),
  expressTransportType: smallint('express_transport_type').notNull().default(4),
  expressAddCountryCode: smallint('express_add_country_code').notNull().default(100),
  expressCountry: smallint('express_country').notNull().default(100),

  consigneeDefaultCityCode: varchar('consignee_default_city_code', { length: 8 }),
  consigneeDefaultZipCode: varchar('consignee_default_zip_code', { length: 8 }),
  consigneeDefaultPoBox: varchar('consignee_default_po_box', { length: 8 }),
  consigneeDefaultStreetAr: text('consignee_default_street_ar'),

  // Was operator_constants.<key>; dropped that table in 0064.
  defaultRegPortCode: varchar('default_reg_port_code', { length: 8 }),
  defaultCarrierPrefix: varchar('default_carrier_prefix', { length: 16 }),
  docRefPrefix: varchar('doc_ref_prefix', { length: 16 }),

  /**
   * Whether Track B should consult `operator_code_overrides` before walking
   * the codebook. Defaults to `true` to preserve existing behavior.
   *
   * Set to `false` per-operator when the override list is operationally
   * untrusted — e.g. when an operator's overrides are known to be
   * ZATCA-pass workarounds rather than true codebook corrections. In that
   * case, the merchant's raw code flows directly into the codebook walk
   * and overrides do not participate in classification. See
   * `lookupTenantOverride()` call site in track-b-code/track-b.ts.
   */
  overridesEnabled: boolean('overrides_enabled').notNull().default(true),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type OperatorDeclarationConfigRow = typeof operatorDeclarationConfig.$inferSelect;
export type NewOperatorDeclarationConfigRow = typeof operatorDeclarationConfig.$inferInsert;
