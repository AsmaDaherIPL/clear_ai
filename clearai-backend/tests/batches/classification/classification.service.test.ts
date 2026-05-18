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
import { operators, operatorFieldMappings, batches, batchItems } from '../../../src/db/schema.js';
import { eq, and } from 'drizzle-orm';
import { runClassificationPhase } from '../../../src/modules/batches/classification/classification.service.js';
import type { DispatchFn } from '../../../src/modules/dispatch/dispatch.contract.ts';
import type { CanonicalLineItem } from '../../../src/modules/operators/operator-config.types.js';
import { newId } from '../../../src/common/utils/uuid.js';

const TEST_OPERATOR_SLUG = 'tcsvc_test';
let testOperatorId: string;

beforeAll(async () => {
  process.env.BATCH_BLOB_CONNECTION ??= 'file://./.local-blob';
  process.env.ZATCA_DECLARATION_NS ??= 'http://www.saudiedi.com/schema/decsub';
  process.env.ZATCA_SUBMITTER_CARRIER_ID ??= 'TEST-CARRIER';
  process.env.ZATCA_SUBMITTER_NAME ??= 'Test Carrier';
});

afterAll(async () => {
  if (testOperatorId) {
    await db().delete(batches).where(eq(batches.operatorId, testOperatorId));
    await db().delete(operatorFieldMappings).where(eq(operatorFieldMappings.operatorId, testOperatorId));
    await db().delete(operators).where(eq(operators.id, testOperatorId));
  }
  await closeDb();
});

beforeEach(async () => {
  // Reset: delete any prior runs + the operator row, recreate operator,
  // capture its uuid for the rest of the test to use as the FK target.
  const existing = await db().select().from(operators).where(eq(operators.slug, TEST_OPERATOR_SLUG)).limit(1);
  if (existing[0]) {
    await db().delete(batches).where(eq(batches.operatorId, existing[0].id));
    await db().delete(operatorFieldMappings).where(eq(operatorFieldMappings.operatorId, existing[0].id));
    await db().delete(operators).where(eq(operators.id, existing[0].id));
  }
  const inserted = await db().insert(operators).values({
    slug: TEST_OPERATOR_SLUG,
    displayName: 'Classification svc test',
    active: true,
    // Identity columns may be NOT NULL post-migration 0054.
    tabadulUserid: 'test',
    tabadulAcctId: 'test',
    brokerLicenseType: '5',
    brokerLicenseNo: '1',
    brokerRepresentativeNo: '1',
    defaultSourceCompanyName: 'Test',
    defaultSourceCompanyNo: '0',
  }).returning();
  testOperatorId = inserted[0]!.id;
});

function canonical(rowIndex: number): CanonicalLineItem {
  return {
    itemId: newId(),
    rowIndex,
    operatorId: testOperatorId,
    operatorSlug: TEST_OPERATOR_SLUG,
    description: `Item ${rowIndex}`,
    waybillNo: `WB-${rowIndex}`,
    merchantHsCode: null,
    merchantSku: null,
    valueAmount: 100,
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
    consigneeAddress: null,
    invoiceDate: null,
  };
}

async function seedBatch(itemCount: number): Promise<{ batchId: string; itemIds: string[] }> {
  const batchId = newId();
  await db().insert(batches).values({
    id: batchId,
    operatorId: testOperatorId,
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

// Build a synthetic DispatchV1Response stub for test fixtures. Tests don't
// exercise the recorder/HITL writes (they pass mock dispatchers that bypass
// dispatch.use-case entirely), so the stub just needs to satisfy the type.
type StubVerdict = 'PASS' | 'FLAG' | null;
function v1Stub(itemId: string, finalCode: string | null, sanityVerdict: StubVerdict, shortCircuit = false) {
  const status: 'succeeded' | 'flagged' | 'rejected' =
    shortCircuit ? 'rejected' : sanityVerdict === 'PASS' ? 'succeeded' : 'flagged';
  return {
    item_id: itemId,
    operator_slug: TEST_OPERATOR_SLUG,
    status,
    final_code: finalCode,
    goods_description_ar: null,
    goods_description_en: null,
    sanity_verdict: sanityVerdict,
    trace: {
      trace_version: 'dispatch-v1' as const,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: 0,
      llm_calls_used: 0,
      summary: {
        merchant_code_state: null,
        description_classifier_code: finalCode,
        code_resolver_code: null,
        reconciliation: null,
        operator_override_applied: false,
        final_code: finalCode,
        sanity_verdict: sanityVerdict,
      },
      stages: [],
    },
  };
}

describe('runClassificationPhase', () => {
  it('marks PASS items succeeded and persists final_code + trace', async () => {
    const { batchId } = await seedBatch(3);
    const dispatch: DispatchFn = async (item) => ({
      finalCode: '010121000000',
      goodsDescriptionAr: 'فستان',
      sanityVerdict: 'PASS',
      hitl: null,
      v1: v1Stub(item.itemId, '010121000000', 'PASS'),
      trace: { stages: [], meta: { rowIndex: item.rowIndex } },
      infraDegraded: false,
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
    const set = await db().select().from(batches).where(eq(batches.id, batchId)).limit(1);
    expect(set[0]!.classificationStatus).toBe('completed');
  });

  it('maps FLAG -> flagged, shortCircuit -> blocked, throws -> failed', async () => {
    const { batchId } = await seedBatch(3);
    let n = 0;
    const dispatch: DispatchFn = async (item) => {
      n++;
      if (n === 1) return {
        finalCode: '010121000000',
        goodsDescriptionAr: 'فستان',
        sanityVerdict: 'FLAG',
        hitl: { reason: 'sanity_flag', cleaned_description: 'item' },
        v1: v1Stub(item.itemId, '010121000000', 'FLAG'),
        trace: { stages: [] },
        infraDegraded: false,
      };
      // Pre-classification short-circuit (parse failure / cleanup
      // unusable). sanityVerdict is null because sanity never ran;
      // shortCircuit=true routes to item-status 'blocked'. Replaces
      // the legacy sanityVerdict='BLOCK' encoding.
      if (n === 2) return {
        finalCode: null,
        goodsDescriptionAr: null,
        sanityVerdict: null,
        shortCircuit: true,
        hitl: null,
        v1: v1Stub(item.itemId, null, null, true),
        trace: { stages: [] },
        infraDegraded: false,
      };
      throw new Error('boom');
    };

    const summary = await runClassificationPhase(batchId, { dispatch, concurrency: 1 });
    expect(summary.flagged).toBe(1);
    expect(summary.blocked).toBe(1);
    expect(summary.failed).toBe(1);

    const items = await db()
      .select()
      .from(batchItems)
      .where(eq(batchItems.batchId, batchId))
      .orderBy(batchItems.rowIndex);
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
    const dispatch: DispatchFn = async (item) => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return {
        finalCode: '010121000000',
        goodsDescriptionAr: 'فستان',
        sanityVerdict: 'PASS',
        hitl: null,
        v1: v1Stub(item.itemId, '010121000000', 'PASS'),
        trace: { stages: [] },
        infraDegraded: false,
      };
    };
    await runClassificationPhase(batchId, { dispatch, concurrency: 2 });
    expect(max).toBeLessThanOrEqual(2);
  });

  it('runs identically for classify_only mode (Phase 1 is mode-agnostic)', async () => {
    const batchId = newId();
    await db().insert(batches).values({
      id: batchId,
      operatorId: testOperatorId,
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
    const dispatch: DispatchFn = async (item) => ({
      finalCode: '010121000000',
      goodsDescriptionAr: 'فستان',
      sanityVerdict: 'PASS',
      hitl: null,
      v1: v1Stub(item.itemId, '010121000000', 'PASS'),
      trace: { stages: [] },
      infraDegraded: false,
    });
    const summary = await runClassificationPhase(batchId, { dispatch });
    expect(summary.succeeded).toBe(1);
    const after = await db().select().from(batches).where(eq(batches.id, batchId)).limit(1);
    expect(after[0]!.classificationStatus).toBe('completed');
    expect(after[0]!.declarationStatus).toBeNull(); // unchanged
  });

  it('handles empty batches without errors', async () => {
    const { batchId } = await seedBatch(0);
    const dispatch: DispatchFn = async (item) => ({
      finalCode: 'x',
      goodsDescriptionAr: 'فستان',
      sanityVerdict: 'PASS',
      hitl: null,
      v1: v1Stub(item.itemId, 'x', 'PASS'),
      trace: { stages: [] },
      infraDegraded: false,
    });
    const summary = await runClassificationPhase(batchId, { dispatch });
    expect(summary.total).toBe(0);
    expect(and).toBeTruthy(); // keep the import used
  });
});
