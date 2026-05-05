/**
 * Seed the Naqel tenant row + its column-mapping rules + constants.
 * Idempotent: re-running re-asserts the rows. Constants and mappings are
 * cleared and re-inserted (per-tenant) so the seed file is the
 * authoritative source for the tenant's config.
 *
 * Usage:
 *   pnpm db:seed:tenants
 */
import { eq } from 'drizzle-orm';
import { db, closeDb } from '../db/client.js';
import { tenantFieldMappings, tenantConstants } from '../db/schema.js';
import { upsertTenant } from '../modules/tenants/tenant.repository.js';
import type { CanonicalField, TransformKind } from '../modules/tenants/tenant-config.types.js';
import { env } from '../config/env.js';

interface SeedMapping {
  sourceColumn: string;
  canonicalField: CanonicalField;
  required: boolean;
  transform: TransformKind;
  defaultValue: string | null;
}

const NAQEL_SLUG = 'naqel';

/**
 * Naqel column → canonical mapping. Sourced from
 *   naqel-shared-data/Naqel (Fields details + Mapping data).xlsx
 *   naqel-shared-data/sample_input_commercial_invoice/light-example/pre-processed (commercial invoice).xlsx
 * The headers below MUST match the source file exactly (case-sensitive).
 *
 * NOTE: when ops onboard a new tenant, they add another seed file here or
 * insert rows directly via psql; no TS edits to the mapper or registry are
 * required. This is the only Naqel-specific data in the codebase.
 */
const NAQEL_MAPPINGS: ReadonlyArray<SeedMapping> = [
  // Identity & description. Naqel ships English-or-Arabic in the same
  // Description column; the classifier detects language. The Arabic
  // description for the ZATCA envelope is produced by dispatch.
  { sourceColumn: 'Description', canonicalField: 'description', required: true, transform: 'trim', defaultValue: null },
  { sourceColumn: 'HS Code', canonicalField: 'merchantHsCode', required: false, transform: 'trim', defaultValue: null },
  { sourceColumn: 'SKU', canonicalField: 'merchantSku', required: false, transform: 'trim', defaultValue: null },
  // Commercial values.
  { sourceColumn: 'Value', canonicalField: 'valueAmount', required: true, transform: null, defaultValue: null },
  { sourceColumn: 'Currency', canonicalField: 'currencyCode', required: true, transform: 'uppercase', defaultValue: null },
  { sourceColumn: 'Quantity', canonicalField: 'quantity', required: true, transform: null, defaultValue: null },
  { sourceColumn: 'UOM', canonicalField: 'uom', required: true, transform: 'uppercase', defaultValue: null },
  { sourceColumn: 'Net Weight', canonicalField: 'netWeightKg', required: true, transform: null, defaultValue: null },
  { sourceColumn: 'Gross Weight', canonicalField: 'grossWeightKg', required: false, transform: null, defaultValue: null },
  // Origin / routing.
  { sourceColumn: 'Country of Origin', canonicalField: 'countryOfOrigin', required: true, transform: 'uppercase', defaultValue: null },
  { sourceColumn: 'Source Country', canonicalField: 'sourceCountry', required: false, transform: 'uppercase', defaultValue: null },
  { sourceColumn: 'Source Port', canonicalField: 'sourcePortCode', required: false, transform: 'uppercase', defaultValue: null },
  { sourceColumn: 'Reg Port', canonicalField: 'regPortCode', required: false, transform: 'uppercase', defaultValue: null },
  // Parties.
  { sourceColumn: 'Shipper Name', canonicalField: 'shipperName', required: false, transform: 'trim', defaultValue: null },
  { sourceColumn: 'Shipper Address', canonicalField: 'shipperAddress', required: false, transform: 'trim', defaultValue: null },
  { sourceColumn: 'Consignee Name', canonicalField: 'consigneeName', required: false, transform: 'trim', defaultValue: null },
  { sourceColumn: 'Consignee Address', canonicalField: 'consigneeAddress', required: false, transform: 'trim', defaultValue: null },
  { sourceColumn: 'Consignee City', canonicalField: 'consigneeCity', required: false, transform: 'trim', defaultValue: null },
  // Document refs.
  { sourceColumn: 'Invoice No', canonicalField: 'invoiceNumber', required: false, transform: 'trim', defaultValue: null },
  { sourceColumn: 'Invoice Date', canonicalField: 'invoiceDate', required: false, transform: 'trim', defaultValue: null },
];

const NAQEL_CONSTANTS_FROM_ENV: ReadonlyArray<{ key: string; envKey: keyof ReturnType<typeof env> }> = [
  { key: 'submitter_carrier_id', envKey: 'ZATCA_SUBMITTER_CARRIER_ID' },
  { key: 'submitter_name', envKey: 'ZATCA_SUBMITTER_NAME' },
];

async function main(): Promise<void> {
  const e = env();
  const tenantRow = await upsertTenant({
    slug: NAQEL_SLUG,
    displayName: 'Naqel',
    bundleSize: 99,
    hvThresholdSar: '1000.00',
    active: true,
  });
  console.log(`tenants  upsert ${tenantRow.slug} (${tenantRow.id}) active=${tenantRow.active}`);

  // Replace this tenant's mappings wholesale.
  await db().delete(tenantFieldMappings).where(eq(tenantFieldMappings.tenant, NAQEL_SLUG));
  for (const m of NAQEL_MAPPINGS) {
    await db().insert(tenantFieldMappings).values({
      tenant: NAQEL_SLUG,
      sourceColumn: m.sourceColumn,
      canonicalField: m.canonicalField,
      required: m.required,
      transform: m.transform,
      defaultValue: m.defaultValue,
    });
  }
  console.log(`mappings inserted ${NAQEL_MAPPINGS.length} rows for ${NAQEL_SLUG}`);

  // Replace this tenant's constants from env.
  await db().delete(tenantConstants).where(eq(tenantConstants.tenant, NAQEL_SLUG));
  for (const c of NAQEL_CONSTANTS_FROM_ENV) {
    const value = String(e[c.envKey]);
    await db().insert(tenantConstants).values({ tenant: NAQEL_SLUG, key: c.key, value });
  }
  console.log(`constants inserted ${NAQEL_CONSTANTS_FROM_ENV.length} rows for ${NAQEL_SLUG}`);

  // Confirm the registry can hydrate it without errors.
  const { resolve } = await import('../modules/tenants/tenant-config.registry.js');
  const cfg = await resolve(NAQEL_SLUG);
  console.log(`registry resolved ${cfg.slug}: ${cfg.mappings.length} mappings, ${Object.keys(cfg.constants).length} constants`);
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err);
    await closeDb();
    process.exit(1);
  });

