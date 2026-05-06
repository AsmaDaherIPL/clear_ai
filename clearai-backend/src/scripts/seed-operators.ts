/**
 * Seed the Naqel operator row + its column-mapping rules + remaining
 * placeholder constants. Idempotent: re-running re-asserts the rows.
 *
 * After migration 0054:
 *   • 7 identity values (tabadul_userid, broker_license_*, default_source_*)
 *     are set as columns on operators directly — no longer per-key rows.
 *   • 14 ZATCA-spec defaults (declaration_type, payment_method, etc.) live
 *     in zatca_declaration_defaults — universal, not seeded per operator.
 *   • The 2 measurement-unit constants are gone — driven by tabadul_codes.uom
 *     lookups now.
 *   • operator_constants is left with placeholders pending Naqel
 *     confirmation: express_default_city / express_zip_code / express_po_box.
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
import { operators, operatorFieldMappings, operatorConstants } from '../db/schema.js';
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
  // Document refs.
  { sourceColumn: 'InvoiceDate',           canonicalField: 'invoiceDate',          required: false, transform: 'trim',      defaultValue: null },
];

/**
 * Naqel's Tabadul identity. Set as typed columns on the operators row.
 * Sourced from the post-processed sample XMLs (NQD26033110789, ...).
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
 * Remaining placeholder constants pending Naqel confirmation. These three
 * keys have suspicious values ('1111', '11', '131') that may need to come
 * from per-row data instead. Once Naqel clarifies, they either move to the
 * canonical line item or to operators columns and operator_constants is dropped.
 */
const NAQEL_PLACEHOLDER_CONSTANTS: ReadonlyArray<{ key: string; value: string; comment: string }> = [
  { key: 'express_default_city', value: '131', comment: 'deccm:city fallback when destination_station lookup misses' },
  { key: 'express_zip_code', value: '1111', comment: 'deccm:zipCode — placeholder pending Naqel spec' },
  { key: 'express_po_box', value: '11', comment: 'deccm:poBox — placeholder pending Naqel spec' },
  { key: 'default_reg_port_code', value: '23', comment: 'decsub:regPort — Naqel default reg port' },
];

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

  // Replace this operator's placeholder constants wholesale.
  await db().delete(operatorConstants).where(eq(operatorConstants.operatorId, operatorId));
  for (const c of NAQEL_PLACEHOLDER_CONSTANTS) {
    await db().insert(operatorConstants).values({ operatorId, key: c.key, value: c.value });
  }
  console.log(`constants inserted ${NAQEL_PLACEHOLDER_CONSTANTS.length} placeholder rows for ${NAQEL_SLUG}`);

  // Confirm the registry can hydrate it without errors.
  const { resolve } = await import('../modules/operators/operator-config.registry.js');
  const cfg = await resolve(NAQEL_SLUG);
  console.log(
    `registry resolved ${cfg.slug}: ${cfg.mappings.length} mappings, ${Object.keys(cfg.constants).length} placeholder constants, identity=${cfg.identity.tabadulUserid}`,
  );
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err);
    await closeDb();
    process.exit(1);
  });
