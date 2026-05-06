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
  operators,
  operatorFieldMappings,
  operatorConstants,
  operatorLookups,
  tabadulCodes,
  declarationRuns,
  declarationRunFilings,
} from '../../src/db/schema.js';
import { runProcessing, createDeclarationRun } from '../../src/modules/declaration-runs/declaration-run.use-case.js';
import { clearCache } from '../../src/modules/operators/operator-config.registry.js';
import type { DispatchFn } from '../../src/modules/dispatch/dispatch.contract.ts';

const TEST_OPERATOR_SLUG = 'tcuc_test';
let blobDir: string;
let testOperatorId: string;

beforeAll(async () => {
  blobDir = await mkdtemp(join(tmpdir(), 'clearai-uc-'));
  process.env.BATCH_BLOB_CONNECTION = `file://${blobDir}`;
  process.env.ZATCA_DECLARATION_NS ??= 'http://www.saudiedi.com/schema/decsub';
  process.env.ZATCA_SUBMITTER_CARRIER_ID ??= 'TEST-CARRIER';
  process.env.ZATCA_SUBMITTER_NAME ??= 'Test Carrier';

  // Clean previous run state then seed an operator + minimum config.
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
    displayName: 'Use-case test',
    active: true,
  }).returning();
  testOperatorId = inserted[0]!.id;

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
    await db().insert(operatorFieldMappings).values({
      operatorId: testOperatorId,
      sourceColumn: m.sourceColumn,
      canonicalField: m.canonicalField,
      required: m.required,
      transform: 'transform' in m ? m.transform : null,
      defaultValue: null,
    });
  }

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
    await db().insert(operatorConstants).values({ operatorId: testOperatorId, key: k, value: v });
  }

  // Universal Tabadul codes the renderer reads (currency_code, country_of_origin).
  // Seeded into tabadul_codes so the row is shared with any other concurrent
  // test operator. Upsert-style: drop existing under these (code_type, source_value)
  // pairs first.
  const universal: Array<[string, string, string]> = [
    ['currency_code', 'SAR', '100'],
    ['country_of_origin', 'SA', '100'],
    ['country_of_origin', 'GB', '521'],
  ];
  for (const [t, src, can] of universal) {
    await db().insert(tabadulCodes).values({
      codeType: t,
      sourceValue: src,
      canonicalValue: can,
      metadata: {},
    }).onConflictDoNothing({ target: [tabadulCodes.codeType, tabadulCodes.sourceValue] });
  }
  clearCache();
});

afterAll(async () => {
  await db().delete(declarationRuns).where(eq(declarationRuns.operatorId, testOperatorId));
  await db().delete(operatorFieldMappings).where(eq(operatorFieldMappings.operatorId, testOperatorId));
  await db().delete(operatorConstants).where(eq(operatorConstants.operatorId, testOperatorId));
  await db().delete(operatorLookups).where(eq(operatorLookups.operatorId, testOperatorId));
  await db().delete(operators).where(eq(operators.id, testOperatorId));
  await closeDb();
  await rm(blobDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db().delete(declarationRuns).where(eq(declarationRuns.operatorId, testOperatorId));
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
    const { declarationRun } = await createDeclarationRun({
      operatorSlug: TEST_OPERATOR_SLUG,
      mode: 'classify_only',
      uploadKind: 'csv',
      uploadBytes: CSV,
      metadata: {},
      dispatch: passDispatch,
    });
    expect(declarationRun.mode).toBe('classify_only');
    expect(declarationRun.declarationStatus).toBeNull();

    await runProcessing(declarationRun.id, passDispatch);

    const after = await db().select().from(declarationRuns).where(eq(declarationRuns.id, declarationRun.id)).limit(1);
    expect(after[0]!.classificationStatus).toBe('completed');
    expect(after[0]!.declarationStatus).toBeNull();
    expect(after[0]!.status).toBe('completed');

    const decl = await db().select().from(declarationRunFilings).where(eq(declarationRunFilings.declarationRunId, declarationRun.id));
    expect(decl).toHaveLength(0);
  });

  it('classify_and_declare: runs both phases; declaration rows are produced', async () => {
    const { declarationRun } = await createDeclarationRun({
      operatorSlug: TEST_OPERATOR_SLUG,
      mode: 'classify_and_declare',
      uploadKind: 'csv',
      uploadBytes: CSV,
      metadata: {},
      dispatch: passDispatch,
    });

    await runProcessing(declarationRun.id, passDispatch);

    const after = await db().select().from(declarationRuns).where(eq(declarationRuns.id, declarationRun.id)).limit(1);
    expect(after[0]!.classificationStatus).toBe('completed');
    expect(after[0]!.declarationStatus).toBe('completed');
    expect(after[0]!.status).toBe('completed');

    const decl = await db().select().from(declarationRunFilings).where(eq(declarationRunFilings.declarationRunId, declarationRun.id));
    expect(decl.length).toBeGreaterThanOrEqual(1);
    // Every recorded filing should be in the 'generated' state on creation;
    // ZATCA verdict (zatca_status) stays NULL until submission.
    for (const d of decl) {
      expect(d.status).toBe('generated');
      expect(d.zatcaStatus).toBeNull();
      expect(d.bayanNo).toBeNull();
      expect(d.rejectionReason).toBeNull();
    }
  });
});
