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
  declarationSets,
  declarationSetItems,
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
  await db().delete(declarationSets).where(eq(declarationSets.tenant, TEST_TENANT_SLUG));
  await db().delete(tenantFieldMappings).where(eq(tenantFieldMappings.tenant, TEST_TENANT_SLUG));
  await db().delete(tenants).where(eq(tenants.slug, TEST_TENANT_SLUG));
  await closeDb();
  await rm(blobDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db().delete(declarationSets).where(eq(declarationSets.tenant, TEST_TENANT_SLUG));
  await db().delete(tenantFieldMappings).where(eq(tenantFieldMappings.tenant, TEST_TENANT_SLUG));
  await db().delete(tenants).where(eq(tenants.slug, TEST_TENANT_SLUG));
  await db().insert(tenants).values({
    slug: TEST_TENANT_SLUG,
    displayName: 'Decl svc test',
    bundleSize: 3,
    hvThresholdSar: '1000.00',
    active: true,
  });
  // The registry validates that every CANONICAL_REQUIRED_FIELDS field has a
  // mapping rule, so seed the minimum set even though the declaration phase
  // itself doesn't apply mappings.
  const minMappings = [
    { sourceColumn: 'Description', canonicalField: 'description' },
    { sourceColumn: 'Value', canonicalField: 'valueAmount' },
    { sourceColumn: 'Currency', canonicalField: 'currencyCode' },
    { sourceColumn: 'Quantity', canonicalField: 'quantity' },
    { sourceColumn: 'UOM', canonicalField: 'uom' },
    { sourceColumn: 'Net Weight', canonicalField: 'netWeightKg' },
    { sourceColumn: 'Country of Origin', canonicalField: 'countryOfOrigin' },
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
  clearCache();
});

interface SeedItem {
  status: 'succeeded' | 'flagged' | 'blocked' | 'failed';
  valueAmount: number;
}

async function seed(itemSpecs: ReadonlyArray<SeedItem>): Promise<string> {
  const declarationSetId = newId();
  await db().insert(declarationSets).values({
    id: declarationSetId,
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
    // The declaration phase only reads canonical.valueAmount; full
    // CanonicalLineItem shape isn't enforced at the DB so we cast a partial.
    await db().insert(declarationSetItems).values({
      declarationSetId,
      rowIndex: i + 1,
      canonical: ({
        itemId: 'placeholder',
        rowIndex: i + 1,
        tenantId: 'placeholder',
        tenantSlug: TEST_TENANT_SLUG,
        description: `Item ${i + 1}`,
        merchantHsCode: null,
        merchantSku: null,
        valueAmount: s.valueAmount,
        currencyCode: 'USD',
        quantity: 1,
        uom: 'EA',
        netWeightKg: 1,
        grossWeightKg: null,
        countryOfOrigin: 'CN',
        sourceCountry: null,
        sourcePortCode: null,
        regPortCode: null,
        shipperName: null,
        shipperAddress: null,
        consigneeName: null,
        consigneeAddress: null,
        consigneeCity: null,
        invoiceNumber: null,
        invoiceDate: null,
      }),
      rawRow: {},
      status: s.status,
      finalCode,
      classificationResult: cls,
    });
  }
  return declarationSetId;
}

describe('runDeclarationPhase', () => {
  it('produces HV bundles for items >= threshold and LV chunks for the rest', async () => {
    // bundleSize=3, threshold=1000.
    const declarationSetId = await seed([
      { status: 'succeeded', valueAmount: 1500 }, // HV
      { status: 'succeeded', valueAmount: 200 },
      { status: 'flagged', valueAmount: 300 },
      { status: 'succeeded', valueAmount: 400 },
      { status: 'succeeded', valueAmount: 500 },  // -> 4 LV items in chunks of 3 = 2 LV bundles
      { status: 'succeeded', valueAmount: 2000 }, // HV
    ]);

    const { runDeclarationPhase } = await import('../../../src/modules/declaration-sets/declaration/declaration.runner.js');
    const summary = await runDeclarationPhase(declarationSetId);
    // Expected: 2 HV + ceil(4/3)=2 LV = 4 bundles total.
    expect(summary.bundleCount).toBe(4);

    const rows = await db()
      .select()
      .from(declarations)
      .where(eq(declarations.declarationSetId, declarationSetId))
      .orderBy(declarations.bundleIndex);
    expect(rows).toHaveLength(4);
    const strategies = rows.map((r) => r.bundleStrategy);
    expect(strategies.filter((s) => s === 'HV_STANDALONE')).toHaveLength(2);
    expect(strategies.filter((s) => s === 'LV_BUNDLED')).toHaveLength(2);

    // declaration_status flips to completed.
    const after = await db().select().from(declarationSets).where(eq(declarationSets.id, declarationSetId)).limit(1);
    expect(after[0]!.declarationStatus).toBe('completed');
  });

  it('excludes blocked and failed items', async () => {
    const declarationSetId = await seed([
      { status: 'succeeded', valueAmount: 100 },
      { status: 'blocked', valueAmount: 200 },
      { status: 'failed', valueAmount: 300 },
      { status: 'flagged', valueAmount: 400 },
    ]);
    const { runDeclarationPhase } = await import('../../../src/modules/declaration-sets/declaration/declaration.runner.js');
    const summary = await runDeclarationPhase(declarationSetId);
    // Only 2 included items; bundleSize=3 so 1 LV bundle.
    expect(summary.bundleCount).toBe(1);
    const rows = await db().select().from(declarations).where(eq(declarations.declarationSetId, declarationSetId));
    expect(rows[0]!.itemCount).toBe(2);
  });

  it('writes XML to the configured blob backend', async () => {
    const declarationSetId = await seed([{ status: 'succeeded', valueAmount: 100 }]);
    const { runDeclarationPhase } = await import('../../../src/modules/declaration-sets/declaration/declaration.runner.js');
    await runDeclarationPhase(declarationSetId);
    const rows = await db().select().from(declarations).where(eq(declarations.declarationSetId, declarationSetId));
    expect(rows[0]!.blobKey).toMatch(new RegExp(`declaration-sets/${declarationSetId}/declarations/0000\\.xml`));

    const { getBlobClient } = await import('../../../src/storage/blob.client.js');
    const buf = await getBlobClient().get(rows[0]!.blobKey);
    expect(buf.toString('utf8')).toContain('<decsub:saudiEDI');
  });
});
