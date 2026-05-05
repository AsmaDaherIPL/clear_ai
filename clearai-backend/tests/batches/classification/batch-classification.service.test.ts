/**
 * Phase 1 (classification) integration tests.
 *
 * Uses the local Postgres (pnpm db:up). Mocks dispatch() only — the brief
 * forbids mocking the database in integration-style tests.
 *
 * Pre-conditions:
 *   - DATABASE_URL must point to the local clearai DB (matches .env defaults)
 *   - migrations 0038–0044 must be applied
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { db, closeDb } from '../../../src/db/client.js';
import { tenants, tenantFieldMappings, batches, batchItems } from '../../../src/db/schema.js';
import { eq, and } from 'drizzle-orm';
import { runClassificationPhase } from '../../../src/modules/batches/classification/batch-classification.service.js';
import type { DispatchFn } from '../../../src/modules/dispatch/dispatch.contract.ts';
import type { CanonicalLineItem } from '../../../src/modules/tenants/tenant-config.types.js';
import { newId } from '../../../src/common/utils/uuid.js';

const TEST_TENANT_SLUG = 'tcsvc_test';

beforeAll(async () => {
  // Make sure required env keys are set so env() doesn't fail. The integration
  // tests assume the local .env or shell already provides DATABASE_URL etc.
  process.env.BATCH_BLOB_CONNECTION ??= 'file://./.local-blob';
  process.env.ZATCA_DECLARATION_NS ??= 'http://www.saudiedi.com/schema/decsub';
  process.env.ZATCA_SUBMITTER_CARRIER_ID ??= 'TEST-CARRIER';
  process.env.ZATCA_SUBMITTER_NAME ??= 'Test Carrier';
});

afterAll(async () => {
  await db().delete(batches).where(eq(batches.tenant, TEST_TENANT_SLUG));
  await db().delete(tenantFieldMappings).where(eq(tenantFieldMappings.tenant, TEST_TENANT_SLUG));
  await db().delete(tenants).where(eq(tenants.slug, TEST_TENANT_SLUG));
  await closeDb();
});

beforeEach(async () => {
  // Per-test cleanup: remove any leftover batches under our test tenant.
  await db().delete(batches).where(eq(batches.tenant, TEST_TENANT_SLUG));
  await db().delete(tenants).where(eq(tenants.slug, TEST_TENANT_SLUG));
  await db().insert(tenants).values({
    slug: TEST_TENANT_SLUG,
    displayName: 'Classification svc test',
    active: true,
  });
});

function canonical(rowIndex: number): CanonicalLineItem {
  return {
    itemId: newId(),
    rowIndex,
    tenantId: '00000000-0000-0000-0000-000000000000',
    tenantSlug: TEST_TENANT_SLUG,
    description: `Item ${rowIndex}`,
    descriptionAr: null,
    merchantHsCode: null,
    merchantSku: null,
    valueAmount: 100,
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
  };
}

async function seedBatch(itemCount: number): Promise<{ batchId: string; itemIds: string[] }> {
  const batchId = newId();
  await db().insert(batches).values({
    id: batchId,
    tenant: TEST_TENANT_SLUG,
    mode: 'classify_and_declare',
    declarationStatus: 'pending',
    sourceBlobKey: 'unused',
    rowCount: itemCount,
  });
  const itemIds: string[] = [];
  for (let i = 1; i <= itemCount; i++) {
    const c = canonical(i);
    itemIds.push(c.itemId);
    await db().insert(batchItems).values({
      id: c.itemId,
      batchId,
      rowIndex: i,
      canonical: c,
      rawRow: {},
      status: 'pending',
    });
  }
  return { batchId, itemIds };
}

describe('runClassificationPhase', () => {
  it('marks PASS items succeeded and persists final_code + trace', async () => {
    const { batchId } = await seedBatch(3);
    const dispatch: DispatchFn = async (item) => ({
      finalCode: '010121000000',
      sanityVerdict: 'PASS',
      trace: { pathTaken: 'agree', stages: [], meta: { rowIndex: item.rowIndex } },
    });

    const summary = await runClassificationPhase(batchId, { dispatch, concurrency: 2 });

    expect(summary.total).toBe(3);
    expect(summary.succeeded).toBe(3);
    expect(summary.failed).toBe(0);

    const items = await db().select().from(batchItems).where(eq(batchItems.batchId, batchId));
    for (const it of items) {
      expect(it.status).toBe('succeeded');
      expect(it.finalCode).toBe('010121000000');
      expect(it.trace).toBeTruthy();
    }
    const batch = await db().select().from(batches).where(eq(batches.id, batchId)).limit(1);
    expect(batch[0]!.classificationStatus).toBe('completed');
  });

  it('maps FLAG -> flagged, BLOCK -> blocked, throws -> failed', async () => {
    const { batchId } = await seedBatch(3);
    let n = 0;
    const dispatch: DispatchFn = async () => {
      n++;
      if (n === 1) return { finalCode: '010121000000', sanityVerdict: 'FLAG', trace: { pathTaken: 'flag', stages: [] } };
      if (n === 2) return { finalCode: '010121000000', sanityVerdict: 'BLOCK', trace: { pathTaken: 'block', stages: [] } };
      throw new Error('boom');
    };

    const summary = await runClassificationPhase(batchId, { dispatch, concurrency: 1 });
    expect(summary.flagged).toBe(1);
    expect(summary.blocked).toBe(1);
    expect(summary.failed).toBe(1);

    const items = await db().select().from(batchItems).where(eq(batchItems.batchId, batchId)).orderBy(batchItems.rowIndex);
    expect(items[0]!.status).toBe('flagged');
    expect(items[0]!.finalCode).toBe('010121000000'); // flagged still keeps code
    expect(items[1]!.status).toBe('blocked');
    expect(items[1]!.finalCode).toBeNull();           // blocked has no final code
    expect(items[2]!.status).toBe('failed');
    expect(items[2]!.error).toContain('boom');
  });

  it('respects concurrency cap (does not exceed configured limit)', async () => {
    const { batchId } = await seedBatch(8);
    let inFlight = 0;
    let max = 0;
    const dispatch: DispatchFn = async () => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { finalCode: '010121000000', sanityVerdict: 'PASS', trace: { pathTaken: 'agree', stages: [] } };
    };
    await runClassificationPhase(batchId, { dispatch, concurrency: 2 });
    expect(max).toBeLessThanOrEqual(2);
  });

  it('runs identically for classify_only mode (Phase 1 is mode-agnostic)', async () => {
    const batchId = newId();
    await db().insert(batches).values({
      id: batchId,
      tenant: TEST_TENANT_SLUG,
      mode: 'classify_only',
      declarationStatus: null,
      sourceBlobKey: 'unused',
      rowCount: 1,
    });
    const c = canonical(1);
    await db().insert(batchItems).values({
      id: c.itemId,
      batchId,
      rowIndex: 1,
      canonical: c,
      rawRow: {},
      status: 'pending',
    });
    const dispatch: DispatchFn = async () => ({
      finalCode: '010121000000',
      sanityVerdict: 'PASS',
      trace: { pathTaken: 'agree', stages: [] },
    });
    const summary = await runClassificationPhase(batchId, { dispatch });
    expect(summary.succeeded).toBe(1);
    const after = await db().select().from(batches).where(eq(batches.id, batchId)).limit(1);
    expect(after[0]!.classificationStatus).toBe('completed');
    expect(after[0]!.declarationStatus).toBeNull(); // unchanged
  });

  it('handles empty batches without errors', async () => {
    const { batchId } = await seedBatch(0);
    const dispatch: DispatchFn = async () => ({ finalCode: 'x', sanityVerdict: 'PASS', trace: { pathTaken: '', stages: [] } });
    const summary = await runClassificationPhase(batchId, { dispatch });
    expect(summary.total).toBe(0);
    expect(and).toBeTruthy(); // keep the import used
  });
});
