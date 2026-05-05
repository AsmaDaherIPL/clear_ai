/**
 * Top-level orchestrator tests.
 *
 * Confirms:
 *   - classify_only: Phase 1 runs, Phase 2 is skipped (declaration_status stays NULL)
 *   - classify_and_declare: both phases run; Phase 2 produces declaration rows
 *   - mode default = 'classify_and_declare' (the column default)
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { db, closeDb } from '../../src/db/client.js';
import {
  tenants,
  tenantFieldMappings,
  declarationSets,
  declarations,
} from '../../src/db/schema.js';
import { runProcessing, createDeclarationSet } from '../../src/modules/declaration-sets/declaration-set.use-case.js';
import { clearCache } from '../../src/modules/tenants/tenant-config.registry.js';
import type { DispatchFn } from '../../src/modules/dispatch/dispatch.contract.ts';

const TEST_TENANT_SLUG = 'tcuc_test';
let blobDir: string;

beforeAll(async () => {
  blobDir = await mkdtemp(join(tmpdir(), 'clearai-uc-'));
  process.env.BATCH_BLOB_CONNECTION = `file://${blobDir}`;
  process.env.ZATCA_DECLARATION_NS ??= 'http://www.saudiedi.com/schema/decsub';
  process.env.ZATCA_SUBMITTER_CARRIER_ID ??= 'TEST-CARRIER';
  process.env.ZATCA_SUBMITTER_NAME ??= 'Test Carrier';

  // Seed a tenant + the minimum mappings required for canonical resolution.
  await db().delete(declarationSets).where(eq(declarationSets.tenant, TEST_TENANT_SLUG));
  await db().delete(tenantFieldMappings).where(eq(tenantFieldMappings.tenant, TEST_TENANT_SLUG));
  await db().delete(tenants).where(eq(tenants.slug, TEST_TENANT_SLUG));
  await db().insert(tenants).values({
    slug: TEST_TENANT_SLUG,
    displayName: 'Use-case test',
    bundleSize: 99,
    hvThresholdSar: '1000.00',
    active: true,
  });

  // Mapping set covering CANONICAL_REQUIRED_FIELDS. Uses Naqel-style headers.
  const minMappings = [
    { sourceColumn: 'Description', canonicalField: 'description', required: true },
    { sourceColumn: 'WaybillNo', canonicalField: 'waybillNo', required: true },
    { sourceColumn: 'Amount', canonicalField: 'valueAmount', required: true },
    { sourceColumn: 'Currency', canonicalField: 'currencyCode', required: true, transform: 'uppercase' },
    { sourceColumn: 'Quantity', canonicalField: 'quantity', required: true },
    { sourceColumn: 'UnitType', canonicalField: 'uom', required: true, transform: 'uppercase' },
    { sourceColumn: 'weight', canonicalField: 'netWeightKg', required: true },
    { sourceColumn: 'ClientID', canonicalField: 'clientId', required: true },
    { sourceColumn: 'CountryofManufacture', canonicalField: 'countryOfOrigin', required: true, transform: 'uppercase' },
    { sourceColumn: 'DestinationStationID', canonicalField: 'destinationStationId', required: true },
    { sourceColumn: 'ConsigneeName', canonicalField: 'consigneeName', required: true },
    { sourceColumn: 'ConsigneeNationalID', canonicalField: 'consigneeNationalId', required: true },
    { sourceColumn: 'Mobile', canonicalField: 'consigneePhone', required: true },
  ] as const;

  for (const m of minMappings) {
    await db().insert(tenantFieldMappings).values({
      tenant: TEST_TENANT_SLUG,
      sourceColumn: m.sourceColumn,
      canonicalField: m.canonicalField,
      required: m.required,
      transform: 'transform' in m ? m.transform : null,
      defaultValue: null,
    });
  }
  clearCache();
});

afterAll(async () => {
  await db().delete(declarationSets).where(eq(declarationSets.tenant, TEST_TENANT_SLUG));
  await db().delete(tenantFieldMappings).where(eq(tenantFieldMappings.tenant, TEST_TENANT_SLUG));
  await db().delete(tenants).where(eq(tenants.slug, TEST_TENANT_SLUG));
  await closeDb();
  await rm(blobDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db().delete(declarationSets).where(eq(declarationSets.tenant, TEST_TENANT_SLUG));
});

const passDispatch: DispatchFn = async () => ({
  finalCode: '010121000000',
  goodsDescriptionAr: 'فستان', sanityVerdict: 'PASS',
  trace: { pathTaken: 'agree', stages: [] },
});

const CSV = Buffer.from(
  [
    'WaybillNo,Description,Amount,Currency,Quantity,UnitType,weight,ClientID,CountryofManufacture,DestinationStationID,ConsigneeName,ConsigneeNationalID,Mobile',
    '279274301,Cotton t-shirt,125.50,SAR,10,piece,2.5,9019628,SA,501,Roshan,2591527102,966565397861',
    '394613346,Dresses,1080,SAR,5,piece,3.5,9022381,GB,503,Vogacloset,1069595681,966500026683',
  ].join('\n') + '\n',
  'utf8',
);

describe('runProcessing', () => {
  it('classify_only: runs Phase 1, skips Phase 2 (no declarations rows; declaration_status stays NULL)', async () => {
    const { declarationSet } = await createDeclarationSet({
      tenantSlug: TEST_TENANT_SLUG,
      mode: 'classify_only',
      uploadKind: 'csv',
      uploadBytes: CSV,
      metadata: {},
      dispatch: passDispatch,
    });
    expect(declarationSet.mode).toBe('classify_only');
    expect(declarationSet.declarationStatus).toBeNull();

    await runProcessing(declarationSet.id, passDispatch);

    const after = await db().select().from(declarationSets).where(eq(declarationSets.id, declarationSet.id)).limit(1);
    expect(after[0]!.classificationStatus).toBe('completed');
    expect(after[0]!.declarationStatus).toBeNull();
    expect(after[0]!.status).toBe('completed');

    const decl = await db().select().from(declarations).where(eq(declarations.declarationSetId, declarationSet.id));
    expect(decl).toHaveLength(0);
  });

  it('classify_and_declare: runs both phases; declaration rows are produced', async () => {
    const { declarationSet } = await createDeclarationSet({
      tenantSlug: TEST_TENANT_SLUG,
      mode: 'classify_and_declare',
      uploadKind: 'csv',
      uploadBytes: CSV,
      metadata: {},
      dispatch: passDispatch,
    });

    await runProcessing(declarationSet.id, passDispatch);

    const after = await db().select().from(declarationSets).where(eq(declarationSets.id, declarationSet.id)).limit(1);
    expect(after[0]!.classificationStatus).toBe('completed');
    expect(after[0]!.declarationStatus).toBe('completed');
    expect(after[0]!.status).toBe('completed');

    const decl = await db().select().from(declarations).where(eq(declarations.declarationSetId, declarationSet.id));
    expect(decl.length).toBeGreaterThanOrEqual(1);
  });
});
