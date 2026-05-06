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
  operators,
  operatorFieldMappings,
  operatorConstants,
  operatorLookups,
  tabadulCodes,
  declarationRuns,
  declarationRunItems,
  declarationRunFilings,
} from '../../../src/db/schema.js';
import { clearCache } from '../../../src/modules/operators/operator-config.registry.js';
import { clearZatcaDefaultsCache } from '../../../src/modules/reference-data/zatca-defaults.repository.js';
import { newId } from '../../../src/common/utils/uuid.js';

const TEST_OPERATOR_SLUG = 'tcdec_test';
let blobDir: string;
let testOperatorId: string;

beforeAll(async () => {
  blobDir = await mkdtemp(join(tmpdir(), 'clearai-decl-'));
  process.env.BATCH_BLOB_CONNECTION = `file://${blobDir}`;
  process.env.ZATCA_DECLARATION_NS ??= 'http://www.saudiedi.com/schema/decsub';
  process.env.ZATCA_SUBMITTER_CARRIER_ID ??= 'TEST-CARRIER';
  process.env.ZATCA_SUBMITTER_NAME ??= 'Test Carrier';
});

afterAll(async () => {
  if (testOperatorId) {
    await db().delete(declarationRuns).where(eq(declarationRuns.operatorId, testOperatorId));
    await db().delete(operatorFieldMappings).where(eq(operatorFieldMappings.operatorId, testOperatorId));
    await db().delete(operatorConstants).where(eq(operatorConstants.operatorId, testOperatorId));
    await db().delete(operatorLookups).where(eq(operatorLookups.operatorId, testOperatorId));
    await db().delete(operators).where(eq(operators.id, testOperatorId));
  }
  await closeDb();
  await rm(blobDir, { recursive: true, force: true });
});

beforeEach(async () => {
  // Reset operator + dependent rows.
  const existing = await db().select().from(operators).where(eq(operators.slug, TEST_OPERATOR_SLUG)).limit(1);
  if (existing[0]) {
    await db().delete(declarationRuns).where(eq(declarationRuns.operatorId, existing[0].id));
    await db().delete(operatorFieldMappings).where(eq(operatorFieldMappings.operatorId, existing[0].id));
    await db().delete(operatorConstants).where(eq(operatorConstants.operatorId, existing[0].id));
    await db().delete(operatorLookups).where(eq(operatorLookups.operatorId, existing[0].id));
    await db().delete(operators).where(eq(operators.id, existing[0].id));
  }
  const inserted = await db().insert(operators).values({
    slug: TEST_OPERATOR_SLUG,
    displayName: 'Decl svc test',
    active: true,
    // Identity columns required by the renderer (post-migration 0054).
    tabadulUserid: 'uwqfr002',
    tabadulAcctId: 'uwqf',
    brokerLicenseType: '5',
    brokerLicenseNo: '1',
    brokerRepresentativeNo: '1732',
    defaultSourceCompanyName: 'ناقل',
    defaultSourceCompanyNo: '340476',
  }).returning();
  testOperatorId = inserted[0]!.id;
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
    await db().insert(operatorFieldMappings).values({
      operatorId: testOperatorId,
      sourceColumn: m.sourceColumn,
      canonicalField: m.canonicalField,
      required: true,
      transform: null,
      defaultValue: null,
    });
  }

  // Only per-operator placeholder constants. Identity moved to operators
  // columns (set above); ZATCA-spec defaults moved to zatca_declaration_defaults
  // (seeded by migration 0053).
  const minConstants: Array<[string, string]> = [
    ['default_reg_port_code', '23'],
    ['express_default_city', '131'],
    ['express_zip_code', '1111'],
    ['express_po_box', '11'],
  ];
  for (const [k, v] of minConstants) {
    await db().insert(operatorConstants).values({ operatorId: testOperatorId, key: k, value: v });
  }

  // Minimum lookups for the renderer to resolve all required values. These
  // are universal Tabadul codes — they live in tabadul_codes, not
  // operator_lookups, so we upsert (any prior test may have seeded them).
  const universal: Array<[string, string, string, Record<string, unknown>]> = [
    ['currency_code', 'USD', '410', {}],
    ['currency_code', 'SAR', '100', {}],
    ['country_of_origin', 'CN', '111', {}],
    ['uom', 'PIECE', '7', {}],
  ];
  for (const [t, src, can, meta] of universal) {
    await db().insert(tabadulCodes).values({
      codeType: t,
      sourceValue: src,
      canonicalValue: can,
      metadata: meta,
    }).onConflictDoNothing({ target: [tabadulCodes.codeType, tabadulCodes.sourceValue] });
  }

  clearCache();
  clearZatcaDefaultsCache();
});

interface SeedItem {
  status: 'succeeded' | 'flagged' | 'blocked' | 'failed';
  valueAmount: number;
}

async function seed(itemSpecs: ReadonlyArray<SeedItem>): Promise<string> {
  const declarationRunId = newId();
  await db().insert(declarationRuns).values({
    id: declarationRunId,
    operatorId: testOperatorId,
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
        operatorId: testOperatorId,
        operatorSlug: TEST_OPERATOR_SLUG,
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

    const { runDeclarationPhase } = await import('../../../src/modules/declaration-runs/filings/declaration.runner.js');
    const summary = await runDeclarationPhase(declarationRunId);
    // Expected: 2 HV + ceil(4/3)=2 LV = 4 bundles total.
    expect(summary.bundleCount).toBe(4);

    const rows = await db()
      .select()
      .from(declarationRunFilings)
      .where(eq(declarationRunFilings.declarationRunId, declarationRunId))
      .orderBy(declarationRunFilings.bundleIndex);
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
    const { runDeclarationPhase } = await import('../../../src/modules/declaration-runs/filings/declaration.runner.js');
    const summary = await runDeclarationPhase(declarationRunId);
    // Only 2 included items; bundleSize=3 so 1 LV bundle.
    expect(summary.bundleCount).toBe(1);
    const rows = await db().select().from(declarationRunFilings).where(eq(declarationRunFilings.declarationRunId, declarationRunId));
    expect(rows[0]!.itemCount).toBe(2);
  });

  it('writes XML to the configured blob backend', async () => {
    const declarationRunId = await seed([{ status: 'succeeded', valueAmount: 100 }]);
    const { runDeclarationPhase } = await import('../../../src/modules/declaration-runs/filings/declaration.runner.js');
    await runDeclarationPhase(declarationRunId);
    const rows = await db().select().from(declarationRunFilings).where(eq(declarationRunFilings.declarationRunId, declarationRunId));
    expect(rows[0]!.blobKey).toMatch(new RegExp(`declaration-runs/${declarationRunId}/declarations/0000\\.xml`));

    const { getBlobClient } = await import('../../../src/storage/blob.client.js');
    const buf = await getBlobClient().get(rows[0]!.blobKey);
    expect(buf.toString('utf8')).toContain('<decsub:saudiEDI');
  });
});
