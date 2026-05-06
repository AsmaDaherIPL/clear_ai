/**
 * Phase 2 (declaration) integration tests.
 *
 * Exercises the runDeclarationPhase end-to-end against the local Postgres +
 * a temp-dir blob backend (BATCH_BLOB_CONNECTION=file://...).
 *
 * Confirms:
 *   - blocked / failed items are EXCLUDED from declarations
 *   - HV partition produces 1 item per declaration
 *   - LV partition chunks by bundleSize
 *   - declaration_status transitions running -> completed
 *   - rows are persisted to the declarations table
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { db, closeDb } from '../../../src/db/client.js';
import {
  tenants,
  tenantFieldMappings,
  tenantConstants,
  tenantLookups,
  declarationRuns,
  declarationRunItems,
  declarations,
} from '../../../src/db/schema.js';
import { clearCache } from '../../../src/modules/tenants/tenant-config.registry.js';
import { newId } from '../../../src/common/utils/uuid.js';

const TEST_TENANT_SLUG = 'tcdec_test';
let blobDir: string;

beforeAll(async () => {
  blobDir = await mkdtemp(join(tmpdir(), 'clearai-decl-'));
  process.env.BATCH_BLOB_CONNECTION = `file://${blobDir}`;
  process.env.ZATCA_DECLARATION_NS ??= 'http://www.saudiedi.com/schema/decsub';
  process.env.ZATCA_SUBMITTER_CARRIER_ID ??= 'TEST-CARRIER';
  process.env.ZATCA_SUBMITTER_NAME ??= 'Test Carrier';
});

afterAll(async () => {
  await db().delete(declarationRuns).where(eq(declarationRuns.tenant, TEST_TENANT_SLUG));
  await db().delete(tenantFieldMappings).where(eq(tenantFieldMappings.tenant, TEST_TENANT_SLUG));
  await db().delete(tenantConstants).where(eq(tenantConstants.tenant, TEST_TENANT_SLUG));
  await db().delete(tenantLookups).where(eq(tenantLookups.tenant, TEST_TENANT_SLUG));
  await db().delete(tenants).where(eq(tenants.slug, TEST_TENANT_SLUG));
  await closeDb();
  await rm(blobDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db().delete(declarationRuns).where(eq(declarationRuns.tenant, TEST_TENANT_SLUG));
  await db().delete(tenantFieldMappings).where(eq(tenantFieldMappings.tenant, TEST_TENANT_SLUG));
  await db().delete(tenantConstants).where(eq(tenantConstants.tenant, TEST_TENANT_SLUG));
  await db().delete(tenantLookups).where(eq(tenantLookups.tenant, TEST_TENANT_SLUG));
  await db().delete(tenants).where(eq(tenants.slug, TEST_TENANT_SLUG));
  await db().insert(tenants).values({
    slug: TEST_TENANT_SLUG,
    displayName: 'Decl svc test',
    active: true,
  });
  // Override the bundle size to 3 so the test exercises LV chunking with
  // few items. ZATCA tunables live in setup_meta (see migration 0046); the
  // declaration runner reads them at phase start. We mutate the value
  // before each test and rely on loadThresholds re-loading on cache miss.
  // Note: setup_meta has a UPDATE-only path for existing keys (the seed
  // ships them at boot via 0046).
  const { getPool } = await import('../../../src/db/client.js');
  await getPool().query(
    `UPDATE setup_meta
       SET value_numeric = 3, value = '3'
     WHERE key = 'ZATCA_BUNDLE_SIZE'`,
  );
  await getPool().query(
    `UPDATE setup_meta
       SET value_numeric = 1000, value = '1000'
     WHERE key = 'ZATCA_HV_THRESHOLD_SAR'`,
  );
  // Force the loadThresholds cache to drop so the override is picked up.
  const { clearSetupMetaCache } = await import('../../../src/modules/reference-data/setup-meta.repository.js');
  clearSetupMetaCache();
  // The registry validates that every CANONICAL_REQUIRED_FIELDS field has a
  // mapping rule, so seed the minimum set even though the declaration phase
  // itself doesn't apply mappings.
  const minMappings = [
    { sourceColumn: 'Description', canonicalField: 'description' },
    { sourceColumn: 'WaybillNo', canonicalField: 'waybillNo' },
    { sourceColumn: 'Amount', canonicalField: 'valueAmount' },
    { sourceColumn: 'Currency', canonicalField: 'currencyCode' },
    { sourceColumn: 'Quantity', canonicalField: 'quantity' },
    { sourceColumn: 'UnitType', canonicalField: 'uom' },
    { sourceColumn: 'weight', canonicalField: 'netWeightKg' },
    { sourceColumn: 'ClientID', canonicalField: 'clientId' },
    { sourceColumn: 'CountryofManufacture', canonicalField: 'countryOfOrigin' },
    { sourceColumn: 'DestinationStationID', canonicalField: 'destinationStationId' },
    { sourceColumn: 'ConsigneeName', canonicalField: 'consigneeName' },
    { sourceColumn: 'ConsigneeNationalID', canonicalField: 'consigneeNationalId' },
    { sourceColumn: 'Mobile', canonicalField: 'consigneePhone' },
  ];
  for (const m of minMappings) {
    await db().insert(tenantFieldMappings).values({
      tenant: TEST_TENANT_SLUG,
      sourceColumn: m.sourceColumn,
      canonicalField: m.canonicalField,
      required: true,
      transform: null,
      defaultValue: null,
    });
  }

  // Tenant constants required by the renderer.
  const minConstants: Array<[string, string]> = [
    ['reference_userid', 'uwqfr002'],
    ['reference_acct_id', 'uwqf'],
    ['default_reg_port_code', '23'],
    ['sender_broker_license_type', '5'],
    ['sender_broker_license_no', '1'],
    ['sender_broker_representative_no', '1732'],
    ['declaration_type', '2'],
    ['final_country', 'SA'],
    ['inspection_group_id', '10'],
    ['payment_method', '1'],
    ['invoice_seq_no', '1'],
    ['invoice_type_id', '5'],
    ['invoice_payment_method_id', '1'],
    ['payment_document_status_id', '0'],
    ['deal_value', '1'],
    ['item_invoice_measurement_unit', '7'],
    ['item_international_measurement_unit', '7'],
    ['item_unit_per_packages', '1'],
    ['item_duty_type_id', '1'],
    ['express_transport_type', '4'],
    ['express_add_country_code', '100'],
    ['express_country', '100'],
    ['express_default_city', '131'],
    ['express_zip_code', '1111'],
    ['express_po_box', '11'],
    ['default_source_company_name', 'ناقل'],
    ['default_source_company_no', '340476'],
  ];
  for (const [k, v] of minConstants) {
    await db().insert(tenantConstants).values({ tenant: TEST_TENANT_SLUG, key: k, value: v });
  }

  // Minimum lookups for the renderer to resolve all required values.
  const minLookups: Array<[string, string, string, Record<string, unknown>]> = [
    ['currency_code', 'USD', '410', {}],
    ['currency_code', 'SAR', '100', {}],
    ['country_of_origin', 'CN', '111', {}],
  ];
  for (const [t, src, can, meta] of minLookups) {
    await db().insert(tenantLookups).values({
      tenant: TEST_TENANT_SLUG,
      lookupType: t,
      sourceValue: src,
      canonicalValue: can,
      metadata: meta,
    });
  }

  clearCache();
});

interface SeedItem {
  status: 'succeeded' | 'flagged' | 'blocked' | 'failed';
  valueAmount: number;
}

async function seed(itemSpecs: ReadonlyArray<SeedItem>): Promise<string> {
  const declarationRunId = newId();
  await db().insert(declarationRuns).values({
    id: declarationRunId,
    tenant: TEST_TENANT_SLUG,
    mode: 'classify_and_declare',
    declarationStatus: 'pending',
    classificationStatus: 'completed',
    sourceBlobKey: 'unused',
    rowCount: itemSpecs.length,
  });
  for (let i = 0; i < itemSpecs.length; i++) {
    const s = itemSpecs[i]!;
    const cls: Record<string, unknown> = { valueAmount: s.valueAmount };
    const finalCode = s.status === 'succeeded' || s.status === 'flagged' ? '010121000000' : null;
    // The declaration phase only reads canonical.valueAmount; the rest of
    // the canonical shape is here just to satisfy the TS contract.
    const goodsDescriptionAr = s.status === 'succeeded' || s.status === 'flagged' ? 'فستان' : null;
    await db().insert(declarationRunItems).values({
      declarationRunId,
      rowIndex: i + 1,
      canonical: {
        itemId: 'placeholder',
        rowIndex: i + 1,
        tenantId: 'placeholder',
        tenantSlug: TEST_TENANT_SLUG,
        description: `Item ${i + 1}`,
        waybillNo: `WB-${i + 1}`,
        merchantHsCode: null,
        merchantSku: null,
        valueAmount: s.valueAmount,
        currencyCode: 'SAR',
        quantity: 1,
        uom: 'PIECE',
        netWeightKg: 1,
        clientId: '9000000',
        countryOfOrigin: 'CN',
        destinationStationId: '501',
        consigneeName: 'Test Consignee',
        consigneeNationalId: '1069595681',
        consigneePhone: '966500000000',
        invoiceDate: null,
      },
      rawRow: {},
      status: s.status,
      finalCode,
      goodsDescriptionAr,
      classificationResult: cls,
    });
  }
  return declarationRunId;
}

describe('runDeclarationPhase', () => {
  it('produces HV bundles for items >= threshold and LV chunks for the rest', async () => {
    // bundleSize=3, threshold=1000.
    const declarationRunId = await seed([
      { status: 'succeeded', valueAmount: 1500 }, // HV
      { status: 'succeeded', valueAmount: 200 },
      { status: 'flagged', valueAmount: 300 },
      { status: 'succeeded', valueAmount: 400 },
      { status: 'succeeded', valueAmount: 500 },  // -> 4 LV items in chunks of 3 = 2 LV bundles
      { status: 'succeeded', valueAmount: 2000 }, // HV
    ]);

    const { runDeclarationPhase } = await import('../../../src/modules/declaration-runs/declaration/declaration.runner.js');
    const summary = await runDeclarationPhase(declarationRunId);
    // Expected: 2 HV + ceil(4/3)=2 LV = 4 bundles total.
    expect(summary.bundleCount).toBe(4);

    const rows = await db()
      .select()
      .from(declarations)
      .where(eq(declarations.declarationRunId, declarationRunId))
      .orderBy(declarations.bundleIndex);
    expect(rows).toHaveLength(4);
    const strategies = rows.map((r) => r.bundleStrategy);
    expect(strategies.filter((s) => s === 'HV_STANDALONE')).toHaveLength(2);
    expect(strategies.filter((s) => s === 'LV_BUNDLED')).toHaveLength(2);

    // declaration_status flips to completed.
    const after = await db().select().from(declarationRuns).where(eq(declarationRuns.id, declarationRunId)).limit(1);
    expect(after[0]!.declarationStatus).toBe('completed');
  });

  it('excludes blocked and failed items', async () => {
    const declarationRunId = await seed([
      { status: 'succeeded', valueAmount: 100 },
      { status: 'blocked', valueAmount: 200 },
      { status: 'failed', valueAmount: 300 },
      { status: 'flagged', valueAmount: 400 },
    ]);
    const { runDeclarationPhase } = await import('../../../src/modules/declaration-runs/declaration/declaration.runner.js');
    const summary = await runDeclarationPhase(declarationRunId);
    // Only 2 included items; bundleSize=3 so 1 LV bundle.
    expect(summary.bundleCount).toBe(1);
    const rows = await db().select().from(declarations).where(eq(declarations.declarationRunId, declarationRunId));
    expect(rows[0]!.itemCount).toBe(2);
  });

  it('writes XML to the configured blob backend', async () => {
    const declarationRunId = await seed([{ status: 'succeeded', valueAmount: 100 }]);
    const { runDeclarationPhase } = await import('../../../src/modules/declaration-runs/declaration/declaration.runner.js');
    await runDeclarationPhase(declarationRunId);
    const rows = await db().select().from(declarations).where(eq(declarations.declarationRunId, declarationRunId));
    expect(rows[0]!.blobKey).toMatch(new RegExp(`declaration-runs/${declarationRunId}/declarations/0000\\.xml`));

    const { getBlobClient } = await import('../../../src/storage/blob.client.js');
    const buf = await getBlobClient().get(rows[0]!.blobKey);
    expect(buf.toString('utf8')).toContain('<decsub:saudiEDI');
  });
});
