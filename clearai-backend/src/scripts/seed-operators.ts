/**
 * Seed the Naqel operator row + its column-mapping rules + remaining
 * placeholder constants. Idempotent: re-running re-asserts the rows.
 *
 * After migrations 0054 + 0056:
 *   • 7 identity values (tabadul_userid, broker_license_*, default_source_*)
 *     are columns on operators.
 *   • The consignee address fallback (cityCode, zipCode, poBox, streetAr)
 *     is one jsonb column `default_consignee_address` on operators.
 *   • 14 ZATCA-spec defaults (declaration_type, payment_method, etc.) live
 *     in zatca_declaration_defaults.
 *   • Measurement units come from tabadul_codes.uom lookups.
 *   • operator_constants now holds only `default_reg_port_code`.
 *
 * Real source columns from
 *   naqel-shared-data/sample_input_commercial_invoice/light-example/pre-processed (commercial invoice).xlsx
 * Real envelope identity from
 *   naqel-shared-data/Naqel (Fields details + Mapping data).xlsx
 *     - "Invoice - Fields"
 *     - "ExpressMailInfomation - Fields"
 *
 * Usage:
 *   pnpm db:seed:operators
 */
import { eq } from 'drizzle-orm';
import { db, closeDb } from '../db/client.js';
import { operators, operatorFieldMappings, operatorDeclarationConfig } from '../db/schema.js';
import { getOperatorBySlug } from '../modules/operators/operator.repository.js';
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
 * pre-processed xlsx (light-example) + the alt sample's header set
 * (Consignee / MobileNo) wired via fallbackColumns.
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
  // Consignee — fallback chains support Naqel's two header variants.
  { sourceColumn: 'ConsigneeName',         canonicalField: 'consigneeName',        required: true,  transform: 'trim',      defaultValue: null, fallbackColumns: ['Consignee'] },
  { sourceColumn: 'ConsigneeNationalID',   canonicalField: 'consigneeNationalId',  required: true,  transform: 'trim',      defaultValue: null },
  { sourceColumn: 'Mobile',                canonicalField: 'consigneePhone',       required: true,  transform: 'trim',      defaultValue: null, fallbackColumns: ['MobileNo', 'PhoneNumber', 'Phone'] },
  // Consignee address — optional per-row override of operators.default_consignee_address.
  // Naqel hasn't shipped a sample with these columns yet; placeholder column
  // names ('ConsigneeCity', etc.) for when they do. Until then the renderer
  // falls back to the operators row's default_consignee_address jsonb.
  { sourceColumn: 'ConsigneeCity',         canonicalField: 'consigneeCityCode',    required: false, transform: 'trim',      defaultValue: null },
  { sourceColumn: 'ConsigneeZipCode',      canonicalField: 'consigneeZipCode',     required: false, transform: 'trim',      defaultValue: null },
  { sourceColumn: 'ConsigneePoBox',        canonicalField: 'consigneePoBox',       required: false, transform: 'trim',      defaultValue: null },
  { sourceColumn: 'ConsigneeAddress',      canonicalField: 'consigneeStreetAr',    required: false, transform: 'trim',      defaultValue: null },
  // Document refs.
  { sourceColumn: 'InvoiceDate',           canonicalField: 'invoiceDate',          required: false, transform: 'trim',      defaultValue: null },
];

/**
 * Naqel's Tabadul identity + consignee-address default. Set as typed columns
 * on the operators row. Sourced from the post-processed sample XMLs
 * (NQD26033110789, ...).
 */
const NAQEL_IDENTITY = {
  tabadulUserid: 'uwqfr002',
  tabadulAcctId: 'uwqf',
  brokerLicenseType: '5',
  brokerLicenseNo: '1',
  brokerRepresentativeNo: '1732',
  defaultSourceCompanyName: 'ناقل',
  defaultSourceCompanyNo: '340476',
};

/**
 * Naqel's row in operator_declaration_config — every render default
 * lives here. Defaults match the post-processed sample XMLs and the
 * Naqel field-mapping spec. zatca_submitter_carrier_id stays null
 * until Naqel ships their ZATCA registration value.
 */
const NAQEL_DECLARATION_CONFIG = {
  // zatca submitter — operator must populate carrier_id from ZATCA registration
  zatcaSubmitterCarrierId: null as string | null,
  zatcaSubmitterName: 'Naqel',
  zatcaDeclarationNamespace: 'http://www.saudiedi.com/schema/decsub',
  // Consignee defaults — placeholder values from the historical test xlsx
  // output; cityCode '131' (Riyadh) is the fallback when the
  // destination_station lookup misses.
  consigneeDefaultCityCode: '131',
  consigneeDefaultZipCode: '1111',
  consigneeDefaultPoBox: '11',
  consigneeDefaultStreetAr: null as string | null,
  // Was operator_constants.<key>; promoted to typed columns in 0064.
  defaultRegPortCode: '23',
  defaultCarrierPrefix: null as string | null,
  docRefPrefix: 'NQD',
};

async function main(): Promise<void> {
  // Upsert operator row with identity columns. Update path needs explicit
  // SET because upsertOperator only sets displayName + active today.
  let row = await getOperatorBySlug(NAQEL_SLUG);
  if (row) {
    const updated = await db()
      .update(operators)
      .set({
        displayName: 'Naqel',
        active: true,
        ...NAQEL_IDENTITY,
      })
      .where(eq(operators.slug, NAQEL_SLUG))
      .returning();
    row = updated[0]!;
  } else {
    const inserted = await db()
      .insert(operators)
      .values({
        slug: NAQEL_SLUG,
        displayName: 'Naqel',
        active: true,
        ...NAQEL_IDENTITY,
      })
      .returning();
    row = inserted[0]!;
  }
  console.log(`operators upsert ${row.slug} (${row.id}) active=${row.active}`);

  const operatorId = row.id;

  // Replace this operator's mappings wholesale.
  await db().delete(operatorFieldMappings).where(eq(operatorFieldMappings.operatorId, operatorId));
  for (const m of NAQEL_MAPPINGS) {
    await db().insert(operatorFieldMappings).values({
      operatorId,
      sourceColumn: m.sourceColumn,
      canonicalField: m.canonicalField,
      required: m.required,
      transform: m.transform,
      defaultValue: m.defaultValue,
      fallbackColumns: m.fallbackColumns ?? [],
    });
  }
  console.log(`mappings inserted ${NAQEL_MAPPINGS.length} rows for ${NAQEL_SLUG}`);

  // Upsert operator_declaration_config — one row per operator.
  await db()
    .insert(operatorDeclarationConfig)
    .values({ operatorId, ...NAQEL_DECLARATION_CONFIG })
    .onConflictDoUpdate({
      target: operatorDeclarationConfig.operatorId,
      set: NAQEL_DECLARATION_CONFIG,
    });
  console.log(`operator_declaration_config upsert for ${NAQEL_SLUG}`);

  // Confirm the registry can hydrate it without errors.
  const { resolve } = await import('../modules/operators/operator-config.registry.js');
  const cfg = await resolve(NAQEL_SLUG);
  console.log(
    `registry resolved ${cfg.slug}: ${cfg.mappings.length} mappings, identity=${cfg.identity.tabadulUserid}`,
  );
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err);
    await closeDb();
    process.exit(1);
  });
