/**
 * Seed the Naqel operator row + its column-mapping rules + ZATCA-envelope
 * constants. Idempotent: re-running re-asserts the rows. Mappings and
 * constants are cleared and re-inserted (per-operator) so the seed file is
 * the authoritative source for the operator's config.
 *
 * Real source columns from
 *   naqel-shared-data/sample_input_commercial_invoice/light-example/pre-processed (commercial invoice).xlsx
 * Real envelope constants from
 *   naqel-shared-data/Naqel (Fields details + Mapping data).xlsx
 *     - "Invoice - Fields"
 *     - "ExpressMailInfomation - Fields"
 *
 * Usage:
 *   pnpm db:seed:tenants
 */
import { eq } from 'drizzle-orm';
import { db, closeDb } from '../db/client.js';
import { operatorFieldMappings, operatorConstants } from '../db/schema.js';
import { upsertOperator } from '../modules/operators/operator.repository.js';
import type { CanonicalField, TransformKind } from '../modules/operators/operator-config.types.js';

interface SeedMapping {
  sourceColumn: string;
  canonicalField: CanonicalField;
  required: boolean;
  transform: TransformKind;
  defaultValue: string | null;
  /** Optional fallback header chain (per migration 0047). */
  fallbackColumns?: string[];
}

const NAQEL_SLUG = 'naqel';

/**
 * Naqel column → canonical mapping. Headers verified against the real
 * pre-processed xlsx (light-example). When a new sample arrives with
 * additional fields (e.g. `InvoiceDate`, `ConsigneeAddress`,
 * `ChineseDescription`), they're either:
 *   • added to CanonicalLineItem if the dispatch agent or renderer needs
 *     them, OR
 *   • ignored by the mapper (they remain in raw_row jsonb for audit).
 *
 * Both lights / scenarios verified:
 *   - sample 1 (Samsung phone, Roshan)             — every column present
 *   - sample 2 (Dresses, رحمة العيسى)              — every column present
 *   - second sample header set has   `Consignee` instead of `ConsigneeName`
 *     and `MobileNo` instead of `Mobile`. Today the seed assumes the
 *     light-example shape (`ConsigneeName`, `Mobile`); when Naqel ships a
 *     unified header set we switch the seed in place. For the broader
 *     header set documented in the task brief, follow up with PR-N to
 *     extend operator_field_mappings with fallback_columns (deferred).
 */
const NAQEL_MAPPINGS: ReadonlyArray<SeedMapping> = [
  // Identity & description.
  { sourceColumn: 'Description',           canonicalField: 'description',          required: true,  transform: 'trim',      defaultValue: null },
  { sourceColumn: 'WaybillNo',             canonicalField: 'waybillNo',            required: true,  transform: 'trim',      defaultValue: null },
  { sourceColumn: 'CustomsCommodityCode',  canonicalField: 'merchantHsCode',       required: false, transform: 'trim',      defaultValue: null },
  { sourceColumn: 'SKU',                   canonicalField: 'merchantSku',          required: false, transform: 'trim',      defaultValue: null },
  // Commercial values.
  { sourceColumn: 'Amount',                canonicalField: 'valueAmount',          required: true,  transform: null,        defaultValue: null },
  { sourceColumn: 'Currency',              canonicalField: 'currencyCode',         required: true,  transform: 'uppercase', defaultValue: null },
  { sourceColumn: 'Quantity',              canonicalField: 'quantity',             required: true,  transform: null,        defaultValue: null },
  { sourceColumn: 'UnitType',              canonicalField: 'uom',                  required: true,  transform: 'uppercase', defaultValue: 'PIECE' },
  { sourceColumn: 'weight',                canonicalField: 'netWeightKg',          required: true,  transform: null,        defaultValue: null },
  // Client + origin + destination.
  { sourceColumn: 'ClientID',              canonicalField: 'clientId',             required: true,  transform: 'trim',      defaultValue: null },
  { sourceColumn: 'CountryofManufacture',  canonicalField: 'countryOfOrigin',      required: true,  transform: 'uppercase', defaultValue: null },
  { sourceColumn: 'DestinationStationID',  canonicalField: 'destinationStationId', required: true,  transform: 'trim',      defaultValue: null },
  // Consignee. Fallback chains support Naqel's two header variants:
  //   light-example:  ConsigneeName, Mobile
  //   alt sample:     Consignee,     MobileNo
  // Both land on the same canonical field; mapper takes the first non-empty.
  { sourceColumn: 'ConsigneeName',         canonicalField: 'consigneeName',        required: true,  transform: 'trim',      defaultValue: null, fallbackColumns: ['Consignee'] },
  { sourceColumn: 'ConsigneeNationalID',   canonicalField: 'consigneeNationalId',  required: true,  transform: 'trim',      defaultValue: null },
  { sourceColumn: 'Mobile',                canonicalField: 'consigneePhone',       required: true,  transform: 'trim',      defaultValue: null, fallbackColumns: ['MobileNo', 'PhoneNumber', 'Phone'] },
  // Document refs.
  // InvoiceDate is in the alt sample header set; light-example doesn't carry
  // it. Mapped optional — renderer falls back to render-time UTC when null.
  { sourceColumn: 'InvoiceDate',           canonicalField: 'invoiceDate',          required: false, transform: 'trim',      defaultValue: null },
];

/**
 * Per-operator constants for the ZATCA Declaration envelope. Sourced from
 * `Invoice - Fields` and `ExpressMailInfomation - Fields` sheets in
 * `Naqel (Fields details + Mapping data).xlsx`.
 *
 * Naming convention: snake_case keys grouped by envelope section so the
 * renderer can fetch them by predictable name.
 *
 * Values that vary per declaration (NQDxxx id, dates, etc.) are NOT here
 * — those come from row data or runtime context.
 */
const NAQEL_CONSTANTS: ReadonlyArray<{ key: string; value: string; comment: string }> = [
  // Reference block (decsub:reference).
  // userid + acctId are Naqel-specific values seen in the post-processed
  // sample XMLs (NQD26033110789, NQD26033110790).
  { key: 'reference_userid', value: 'uwqfr002', comment: 'decsub:userid' },
  { key: 'reference_acct_id', value: 'uwqf', comment: 'decsub:acctId' },

  // Sender information block (decsub:senderInformation).
  { key: 'sender_broker_license_type', value: '5', comment: 'deccm:brokerLicenseType' },
  { key: 'sender_broker_license_no', value: '1', comment: 'deccm:brokerLicenseNo' },
  { key: 'sender_broker_representative_no', value: '1732', comment: 'deccm:brokerRepresentativeNo' },

  // Declaration header block (decsub:declarationHeader).
  { key: 'declaration_type', value: '2', comment: 'decsub:declarationType' },
  { key: 'final_country', value: 'SA', comment: 'decsub:finalCountry' },
  { key: 'inspection_group_id', value: '10', comment: 'decsub:inspectionGroupID' },
  { key: 'payment_method', value: '1', comment: 'decsub:paymentMethod' },

  // Invoice block (decsub:invoices).
  { key: 'invoice_seq_no', value: '1', comment: 'decsub:invoiceSeqNo' },
  { key: 'invoice_type_id', value: '5', comment: 'deccm:invoiceType' },
  { key: 'invoice_payment_method_id', value: '1', comment: 'deccm:invoicePayment' },
  { key: 'payment_document_status_id', value: '0', comment: 'deccm:paymentDocumentsStatus' },
  { key: 'deal_value', value: '1', comment: 'deccm:deal' },

  // InvoiceItem block (decsub:items).
  { key: 'item_invoice_measurement_unit', value: '7', comment: 'deccm:invoiceMeasurementUnit' },
  { key: 'item_international_measurement_unit', value: '7', comment: 'deccm:internationalMeasurementUnit' },
  { key: 'item_unit_per_packages', value: '1', comment: 'deccm:unitPerPackages' },
  { key: 'item_duty_type_id', value: '1', comment: 'deccm:itemDutyType' },

  // Express mail information block (decsub:expressMailInfomation).
  // TransportIdType is conditional (5 if national_id starts with 1, 3 if
  // starts with 2) — that's runtime logic in the renderer, not a constant.
  { key: 'express_transport_type', value: '4', comment: 'deccm:transportType' },
  { key: 'express_add_country_code', value: '100', comment: 'deccm:addCtryCd' },
  { key: 'express_country', value: '100', comment: 'deccm:country' },
  { key: 'express_default_city', value: '131', comment: 'deccm:city — default; resolved via operator_lookups.destination_station otherwise' },
  { key: 'express_zip_code', value: '1111', comment: 'deccm:zipCode' },
  { key: 'express_po_box', value: '11', comment: 'deccm:poBox' },

  // Default sender for cust_reg_port_code=23 (Naqel's own; per the
  // SourceCompanies field-spec).
  { key: 'default_source_company_name', value: 'ناقل', comment: 'deccm:sourceCompanyName when cust_reg_port_code=23' },
  { key: 'default_source_company_no', value: '340476', comment: 'decsub:sourceCompanyNo when cust_reg_port_code=23' },
];

async function main(): Promise<void> {
  const tenantRow = await upsertOperator({
    slug: NAQEL_SLUG,
    displayName: 'Naqel',
    active: true,
  });
  console.log(`tenants  upsert ${tenantRow.slug} (${tenantRow.id}) active=${tenantRow.active}`);

  // Replace this operator's mappings wholesale.
  await db().delete(operatorFieldMappings).where(eq(operatorFieldMappings.operatorSlug, NAQEL_SLUG));
  for (const m of NAQEL_MAPPINGS) {
    await db().insert(operatorFieldMappings).values({
      operatorSlug: NAQEL_SLUG,
      sourceColumn: m.sourceColumn,
      canonicalField: m.canonicalField,
      required: m.required,
      transform: m.transform,
      defaultValue: m.defaultValue,
      fallbackColumns: m.fallbackColumns ?? [],
    });
  }
  console.log(`mappings inserted ${NAQEL_MAPPINGS.length} rows for ${NAQEL_SLUG}`);

  // Replace this operator's constants wholesale.
  await db().delete(operatorConstants).where(eq(operatorConstants.operatorSlug, NAQEL_SLUG));
  for (const c of NAQEL_CONSTANTS) {
    await db().insert(operatorConstants).values({ operatorSlug: NAQEL_SLUG, key: c.key, value: c.value });
  }
  console.log(`constants inserted ${NAQEL_CONSTANTS.length} rows for ${NAQEL_SLUG}`);

  // Confirm the registry can hydrate it without errors.
  const { resolve } = await import('../modules/operators/operator-config.registry.js');
  const cfg = await resolve(NAQEL_SLUG);
  console.log(
    `registry resolved ${cfg.slug}: ${cfg.mappings.length} mappings, ${Object.keys(cfg.constants).length} constants`,
  );
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err);
    await closeDb();
    process.exit(1);
  });
