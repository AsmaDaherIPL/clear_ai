/**
 * Review queue route integration tests.
 *
 * Boots a Fastify instance, seeds a classification_events row + a
 * hitl_queue row (and optionally a batch_items row with a
 * trace), then drives the four endpoints. Hits the live DB so
 * docker-compose Postgres must be up.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { reviewRoutes } from '../../src/modules/review/review.routes.js';
import { getPool, closeDb } from '../../src/db/client.js';
import { newId } from '../../src/common/utils/uuid.js';

const TEST_OPERATOR_SLUG = 'thitl_test';
let testOperatorId: string;
let testRunId: string;
let testRowIndexCounter = 0;
let app: FastifyInstance;

/**
 * Codebook codes that exist on every dev DB (loaded from the ZATCA seed).
 * Used as the override target in tests so the codebook-existence check
 * passes for the force=true path.
 */
const SEED_CODE_T_SHIRT = '610910000000'; // T-shirts of cotton, knitted
const SEED_CODE_PARENT = '610910000099'; // Other variant — used as alternative

interface SeedOpts {
  reason?: 'verdict_escalate' | 'sanity_flag' | 'low_information' | 'verifier_uncertain';
  /** Attach a batch_items row with this trace shape. */
  withItem?: {
    finalCode: string;
    confidence: number;
    annotatedCandidates: Array<{
      code: string;
      fit: 'fits' | 'partial' | 'does_not_fit';
      description_en?: string;
      description_ar?: string;
      rationale?: string;
      source_arm?: string;
      rerank_score?: number;
    }>;
    sanityVerdict?: 'PASS' | 'FLAG';
    sanityRationale?: string;
  };
}

async function seedEventAndQueueRow(opts?: SeedOpts): Promise<{
  eventId: string;
  queueId: string;
  itemId: string;
}> {
  const eventId = newId();
  const queueId = newId();
  const pool = getPool();
  await pool.query(
    `INSERT INTO classification_events (
      id, operator_id, operator_slug, status, total_latency_ms, request, trace
    ) VALUES ($1, $2, $3, 'flagged', 0, $4, $5)`,
    [eventId, testOperatorId, TEST_OPERATOR_SLUG, JSON.stringify({ test: true }), JSON.stringify({ stages: [] })],
  );

  // The hitl_queue.item_id can either match classification_events.id
  // (single-shot review) OR match a batch_items.id (batch
  // review). When withItem is set we seed a batch-item row + use its id.
  let itemId = eventId;
  if (opts?.withItem) {
    testRowIndexCounter += 1;
    const driId = newId();
    const trace = {
      stages: [],
      meta: {
        pick: {
          kind: 'accepted',
          final_code: opts.withItem.finalCode,
          confidence: opts.withItem.confidence,
          annotated_candidates: opts.withItem.annotatedCandidates.map((c) => ({
            code: c.code,
            fit: c.fit,
            description_en: c.description_en ?? null,
            description_ar: c.description_ar ?? null,
            rationale: c.rationale ?? '',
            source_arm: c.source_arm ?? 'family_chapter',
            rerank_score: c.rerank_score ?? 0.1,
          })),
        },
        sanity: opts.withItem.sanityVerdict
          ? {
              verdict: opts.withItem.sanityVerdict,
              rationale: opts.withItem.sanityRationale ?? 'test sanity',
            }
          : null,
      },
    };
    await pool.query(
      `INSERT INTO batch_items (
        id, batch_id, row_index, canonical, raw_row, status, final_code, trace
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        driId,
        testRunId,
        testRowIndexCounter,
        JSON.stringify({ description: 'test product' }),
        JSON.stringify({}),
        'flagged',
        opts.withItem.finalCode,
        JSON.stringify(trace),
      ],
    );
    itemId = driId;
  }

  await pool.query(
    `INSERT INTO hitl_queue (
      id, enqueued_at, classification_event_id, item_id, operator_slug, reason, payload
    ) VALUES ($1, now(), $2, $3, $4, $5, $6)`,
    [
      queueId,
      eventId,
      itemId,
      TEST_OPERATOR_SLUG,
      opts?.reason ?? 'sanity_flag',
      JSON.stringify({ cleaned_description: 'test item' }),
    ],
  );
  return { eventId, queueId, itemId };
}

beforeAll(async () => {
  const pool = getPool();
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM operators WHERE slug = $1 LIMIT 1`,
    [TEST_OPERATOR_SLUG],
  );
  if (existing.rowCount && existing.rows[0]) {
    testOperatorId = existing.rows[0].id;
  } else {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO operators (
        slug, display_name, active,
        tabadul_userid, tabadul_acct_id,
        broker_license_type, broker_license_no, broker_representative_no,
        default_source_company_name, default_source_company_no, default_reg_port_code
      ) VALUES ($1, $2, true, 'test', 'test', '5', '1', '1', 'Test', '0', '000')
      RETURNING id`,
      [TEST_OPERATOR_SLUG, 'Review routes test'],
    );
    testOperatorId = inserted.rows[0]!.id;
  }

  // Seed a parent batch for the with-item tests. One per
  // test file is fine — child rows get unique row_index.
  const runInsert = await pool.query<{ id: string }>(
    `INSERT INTO batches (
      operator_id, mode, source_blob_key, row_count, classification_status
    ) VALUES ($1, 'classify_only', 'test/blob', 100, 'pending')
    RETURNING id`,
    [testOperatorId],
  );
  testRunId = runInsert.rows[0]!.id;

  app = Fastify({ logger: false });
  await app.register(reviewRoutes);
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
  const pool = getPool();
  if (testRunId) {
    await pool.query(`DELETE FROM batches WHERE id = $1`, [testRunId]);
  }
  await pool.query(`DELETE FROM classification_events WHERE operator_slug = $1`, [TEST_OPERATOR_SLUG]);
  if (testOperatorId) {
    await pool.query(`DELETE FROM operators WHERE id = $1`, [testOperatorId]);
  }
  await closeDb();
});

beforeEach(async () => {
  // Order matters: batch-item rows reference batches (kept) and the
  // hitl_queue references classification_events (deleted). Cascade
  // takes care of hitl_queue.
  const pool = getPool();
  await pool.query(`DELETE FROM batch_items WHERE batch_id = $1`, [testRunId]);
  await pool.query(`DELETE FROM classification_events WHERE operator_slug = $1`, [TEST_OPERATOR_SLUG]);
  testRowIndexCounter = 0;
});

describe('GET /classifications/review', () => {
  it('returns rows', async () => {
    await seedEventAndQueueRow();
    await seedEventAndQueueRow();

    const res = await app.inject({
      method: 'GET',
      url: `/classifications/review`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: unknown[]; total: number };
    expect(body.items.length).toBe(2);
    expect(body.total).toBe(2);
  });

  it('filters by status', async () => {
    const { queueId } = await seedEventAndQueueRow();
    await getPool().query(`UPDATE hitl_queue SET status = 'resolved' WHERE id = $1`, [queueId]);
    await seedEventAndQueueRow();

    const pendingRes = await app.inject({
      method: 'GET',
      url: `/classifications/review?status=pending`,
    });
    expect(pendingRes.statusCode).toBe(200);
    expect((pendingRes.json() as { items: unknown[] }).items.length).toBe(1);

    const resolvedRes = await app.inject({
      method: 'GET',
      url: `/classifications/review?status=resolved`,
    });
    expect((resolvedRes.json() as { items: unknown[] }).items.length).toBe(1);
  });

  it('accepts verifier_uncertain as a reason filter (widened in this PR)', async () => {
    await seedEventAndQueueRow({ reason: 'verifier_uncertain' });
    await seedEventAndQueueRow({ reason: 'sanity_flag' });

    const res = await app.inject({
      method: 'GET',
      url: `/classifications/review?reason=verifier_uncertain`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ reason: string }> };
    expect(body.items.length).toBe(1);
    expect(body.items[0]!.reason).toBe('verifier_uncertain');
  });
});

describe('GET /classifications/review/:id', () => {
  it('returns flattened candidates + current state when batch-item row exists', async () => {
    const { queueId } = await seedEventAndQueueRow({
      withItem: {
        finalCode: SEED_CODE_T_SHIRT,
        confidence: 0.55, // below gate — can_override should be true
        annotatedCandidates: [
          { code: SEED_CODE_T_SHIRT, fit: 'fits', description_en: 'Cotton t-shirts' },
          { code: SEED_CODE_PARENT, fit: 'partial', description_en: 'Other t-shirts' },
        ],
        sanityVerdict: 'PASS',
        sanityRationale: 'plausible price',
      },
    });
    const res = await app.inject({ method: 'GET', url: `/classifications/review/${queueId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      id: string;
      current_final_code: string;
      current_classification_confidence: number;
      current_sanity_verdict: string;
      can_override: boolean;
      can_block_from_submission: boolean;
      candidates: Array<{ code: string; is_current: boolean; fit: string }>;
    };
    expect(body.id).toBe(queueId);
    expect(body.current_final_code).toBe(SEED_CODE_T_SHIRT);
    expect(body.current_classification_confidence).toBe(0.55);
    expect(body.current_sanity_verdict).toBe('PASS');
    expect(body.can_override).toBe(true);
    expect(body.can_block_from_submission).toBe(true);
    expect(body.candidates.length).toBe(2);
    expect(body.candidates.find((c) => c.code === SEED_CODE_T_SHIRT)?.is_current).toBe(true);
    expect(body.candidates.find((c) => c.code === SEED_CODE_PARENT)?.is_current).toBe(false);
  });

  it('can_override = false when confidence >= 0.60', async () => {
    const { queueId } = await seedEventAndQueueRow({
      withItem: {
        finalCode: SEED_CODE_T_SHIRT,
        confidence: 0.85,
        annotatedCandidates: [{ code: SEED_CODE_T_SHIRT, fit: 'fits' }],
      },
    });
    const res = await app.inject({ method: 'GET', url: `/classifications/review/${queueId}` });
    const body = res.json() as { can_override: boolean; can_block_from_submission: boolean };
    expect(body.can_override).toBe(false);
    // Block is always allowed on open rows regardless of confidence.
    expect(body.can_block_from_submission).toBe(true);
  });

  it('404s on unknown id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/classifications/review/00000000-0000-0000-0000-000000000000',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /classifications/review/:id/claim', () => {
  it('flips pending → in_review', async () => {
    const { queueId } = await seedEventAndQueueRow();
    const res = await app.inject({ method: 'POST', url: `/classifications/review/${queueId}/claim` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe('in_review');
  });

  it('409s when row is already in_review', async () => {
    const { queueId } = await seedEventAndQueueRow();
    await app.inject({ method: 'POST', url: `/classifications/review/${queueId}/claim` });
    const res = await app.inject({ method: 'POST', url: `/classifications/review/${queueId}/claim` });
    expect(res.statusCode).toBe(409);
  });
});

describe('PATCH /classifications/review/:id — approve / reject', () => {
  it('approve → resolved (no reviewer_code required)', async () => {
    const { queueId } = await seedEventAndQueueRow();
    const res = await app.inject({
      method: 'PATCH',
      url: `/classifications/review/${queueId}`,
      payload: { decision: 'approve' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; reviewer_decision: string };
    expect(body.status).toBe('resolved');
    expect(body.reviewer_decision).toBe('approve');
  });

  it('approve rejects reviewer_code (zod superRefine)', async () => {
    const { queueId } = await seedEventAndQueueRow();
    const res = await app.inject({
      method: 'PATCH',
      url: `/classifications/review/${queueId}`,
      payload: { decision: 'approve', reviewer_code: '610910000000' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('reject → dismissed', async () => {
    const { queueId } = await seedEventAndQueueRow();
    const res = await app.inject({
      method: 'PATCH',
      url: `/classifications/review/${queueId}`,
      payload: { decision: 'reject', reviewer_notes: 'bogus' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe('dismissed');
  });

  it('409s when row is already resolved', async () => {
    const { queueId } = await seedEventAndQueueRow();
    await app.inject({
      method: 'PATCH',
      url: `/classifications/review/${queueId}`,
      payload: { decision: 'approve' },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/classifications/review/${queueId}`,
      payload: { decision: 'approve' },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('PATCH /classifications/review/:id — override', () => {
  it('override requires reviewer_code (400 without)', async () => {
    const { queueId } = await seedEventAndQueueRow();
    const noCode = await app.inject({
      method: 'PATCH',
      url: `/classifications/review/${queueId}`,
      payload: { decision: 'override' },
    });
    expect(noCode.statusCode).toBe(400);
  });

  it('override succeeds when reviewer_code is in the candidate set and confidence < 0.60', async () => {
    const { queueId } = await seedEventAndQueueRow({
      withItem: {
        finalCode: SEED_CODE_T_SHIRT,
        confidence: 0.55,
        annotatedCandidates: [
          { code: SEED_CODE_T_SHIRT, fit: 'fits' },
          { code: SEED_CODE_PARENT, fit: 'partial' },
        ],
      },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/classifications/review/${queueId}`,
      payload: {
        decision: 'override',
        reviewer_code: SEED_CODE_PARENT,
        reviewer_notes: 'reviewer picked alt',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      status: string;
      reviewer_code: string;
      item_patched: { previous_final_code: string; new_final_code: string };
    };
    expect(body.status).toBe('resolved');
    expect(body.reviewer_code).toBe(SEED_CODE_PARENT);
    expect(body.item_patched.previous_final_code).toBe(SEED_CODE_T_SHIRT);
    expect(body.item_patched.new_final_code).toBe(SEED_CODE_PARENT);
  });

  it('override rejected with 403 when confidence >= 0.60 and force is absent', async () => {
    const { queueId } = await seedEventAndQueueRow({
      withItem: {
        finalCode: SEED_CODE_T_SHIRT,
        confidence: 0.85,
        annotatedCandidates: [
          { code: SEED_CODE_T_SHIRT, fit: 'fits' },
          { code: SEED_CODE_PARENT, fit: 'partial' },
        ],
      },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/classifications/review/${queueId}`,
      payload: { decision: 'override', reviewer_code: SEED_CODE_PARENT },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('override_not_allowed_high_confidence');
  });

  it('override with force=true bypasses the confidence gate', async () => {
    const { queueId } = await seedEventAndQueueRow({
      withItem: {
        finalCode: SEED_CODE_T_SHIRT,
        confidence: 0.85,
        annotatedCandidates: [
          { code: SEED_CODE_T_SHIRT, fit: 'fits' },
          { code: SEED_CODE_PARENT, fit: 'partial' },
        ],
      },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/classifications/review/${queueId}`,
      payload: {
        decision: 'override',
        reviewer_code: SEED_CODE_PARENT,
        reviewer_notes: 'retrieval missed it',
        force: true,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { reviewer_notes: string };
    // force audit marker prepended to notes.
    expect(body.reviewer_notes).toMatch(/^\[force_override_outside_candidate_set\]/);
  });

  it('override rejected with 422 when reviewer_code is not in candidate set (no force)', async () => {
    const { queueId } = await seedEventAndQueueRow({
      withItem: {
        finalCode: SEED_CODE_T_SHIRT,
        confidence: 0.55,
        annotatedCandidates: [{ code: SEED_CODE_T_SHIRT, fit: 'fits' }],
      },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/classifications/review/${queueId}`,
      payload: { decision: 'override', reviewer_code: SEED_CODE_PARENT },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('reviewer_code_not_in_candidates');
  });

  it('force=true on decision != override is rejected by zod', async () => {
    const { queueId } = await seedEventAndQueueRow();
    const res = await app.inject({
      method: 'PATCH',
      url: `/classifications/review/${queueId}`,
      payload: { decision: 'approve', force: true },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('PATCH /classifications/review/:id — block_from_submission', () => {
  it('blocks and sets excluded_from_xml=true on the batch-item row', async () => {
    const { queueId, itemId } = await seedEventAndQueueRow({
      reason: 'sanity_flag',
      withItem: {
        finalCode: SEED_CODE_T_SHIRT,
        confidence: 0.85,
        annotatedCandidates: [{ code: SEED_CODE_T_SHIRT, fit: 'fits' }],
        sanityVerdict: 'FLAG',
        sanityRationale: 'price implausible',
      },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/classifications/review/${queueId}`,
      payload: {
        decision: 'block_from_submission',
        reviewer_notes: 'Confirmed pricing error; removing.',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      status: string;
      reviewer_decision: string;
      item_blocked: { item_id: string; excluded_from_xml: boolean };
    };
    expect(body.status).toBe('resolved');
    expect(body.reviewer_decision).toBe('block_from_submission');
    expect(body.item_blocked.item_id).toBe(itemId);
    expect(body.item_blocked.excluded_from_xml).toBe(true);

    // Verify the batch-item row was actually flipped.
    const dri = await getPool().query<{
      status: string;
      excluded_from_xml: boolean;
      blocked_reason: string;
    }>(
      `SELECT status, excluded_from_xml, blocked_reason
         FROM batch_items WHERE id = $1`,
      [itemId],
    );
    expect(dri.rows[0]!.status).toBe('blocked');
    expect(dri.rows[0]!.excluded_from_xml).toBe(true);
    expect(dri.rows[0]!.blocked_reason).toBe('reviewer_decision');
  });

  it('block_from_submission rejects without reviewer_notes', async () => {
    const { queueId } = await seedEventAndQueueRow();
    const res = await app.inject({
      method: 'PATCH',
      url: `/classifications/review/${queueId}`,
      payload: { decision: 'block_from_submission' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('block_from_submission rejects short reviewer_notes (< 10 chars)', async () => {
    const { queueId } = await seedEventAndQueueRow();
    const res = await app.inject({
      method: 'PATCH',
      url: `/classifications/review/${queueId}`,
      payload: { decision: 'block_from_submission', reviewer_notes: 'too short' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('block_from_submission rejects when reviewer_code is supplied', async () => {
    const { queueId } = await seedEventAndQueueRow();
    const res = await app.inject({
      method: 'PATCH',
      url: `/classifications/review/${queueId}`,
      payload: {
        decision: 'block_from_submission',
        reviewer_notes: 'Confirmed pricing error; removing.',
        reviewer_code: SEED_CODE_T_SHIRT,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('block_from_submission is allowed on verifier_uncertain rows (not just sanity_flag)', async () => {
    const { queueId } = await seedEventAndQueueRow({
      reason: 'verifier_uncertain',
      withItem: {
        finalCode: SEED_CODE_T_SHIRT,
        confidence: 0.55,
        annotatedCandidates: [{ code: SEED_CODE_T_SHIRT, fit: 'partial' }],
      },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/classifications/review/${queueId}`,
      payload: {
        decision: 'block_from_submission',
        reviewer_notes: 'genuinely uninclassifiable, dropping',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { reviewer_decision: string };
    expect(body.reviewer_decision).toBe('block_from_submission');
  });
});
