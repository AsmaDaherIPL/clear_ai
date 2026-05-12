/**
 * HITL queue route integration tests.
 *
 * Boots a Fastify instance, seeds a classification_events row + a
 * hitl_queue row, then drives the four endpoints. Hits the live DB so
 * docker-compose Postgres must be up.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { hitlRoutes } from '../../src/modules/hitl/hitl.routes.js';
import { getPool, closeDb } from '../../src/db/client.js';
import { newId } from '../../src/common/utils/uuid.js';

const TEST_OPERATOR_SLUG = 'thitl_test';
let testOperatorId: string;
let app: FastifyInstance;

async function seedEventAndQueueRow(opts?: { reason?: 'verdict_escalate' | 'sanity_flag' }): Promise<{
  eventId: string;
  queueId: string;
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
  await pool.query(
    `INSERT INTO hitl_queue (
      id, enqueued_at, classification_event_id, item_id, operator_slug, reason, payload
    ) VALUES ($1, now(), $2, $3, $4, $5, $6)`,
    [
      queueId,
      eventId,
      eventId,
      TEST_OPERATOR_SLUG,
      opts?.reason ?? 'sanity_flag',
      JSON.stringify({ cleaned_description: 'test item' }),
    ],
  );
  return { eventId, queueId };
}

beforeAll(async () => {
  // Operator row required for the FK from classification_events.operator_id.
  // Use raw SQL so the test doesn't depend on the Drizzle operators schema
  // matching the local DB exactly (a column drift in unrelated migrations
  // would otherwise break this test for no good reason).
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
      [TEST_OPERATOR_SLUG, 'HITL routes test'],
    );
    testOperatorId = inserted.rows[0]!.id;
  }

  app = Fastify({ logger: false });
  await app.register(hitlRoutes);
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
  const pool = getPool();
  await pool.query(`DELETE FROM classification_events WHERE operator_slug = $1`, [TEST_OPERATOR_SLUG]);
  if (testOperatorId) {
    await pool.query(`DELETE FROM operators WHERE id = $1`, [testOperatorId]);
  }
  await closeDb();
});

beforeEach(async () => {
  await getPool().query(`DELETE FROM classification_events WHERE operator_slug = $1`, [TEST_OPERATOR_SLUG]);
});

describe('GET /classifications/review', () => {
  it('returns rows filtered by operator_slug', async () => {
    await seedEventAndQueueRow();
    await seedEventAndQueueRow();

    // operator_slug filter removed in the 2026-05-12 API cutover
    // (single-operator V1). Test now lists without any filter.
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

  // 'rejects malformed operator_slug' test removed — operator_slug is
  // no longer a query parameter on this endpoint.
});

describe('GET /classifications/review/:id', () => {
  it('returns the row including the forensic payload', async () => {
    const { queueId } = await seedEventAndQueueRow();
    const res = await app.inject({ method: 'GET', url: `/classifications/review/${queueId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; payload: { cleaned_description: string } };
    expect(body.id).toBe(queueId);
    expect(body.payload.cleaned_description).toBe('test item');
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

describe('PATCH /classifications/review/:id (decide)', () => {
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

  it('override requires reviewer_code', async () => {
    const { queueId } = await seedEventAndQueueRow();
    const noCode = await app.inject({
      method: 'PATCH',
      url: `/classifications/review/${queueId}`,
      payload: { decision: 'override' },
    });
    expect(noCode.statusCode).toBe(400);

    const withCode = await app.inject({
      method: 'PATCH',
      url: `/classifications/review/${queueId}`,
      payload: { decision: 'override', reviewer_code: '610910000000', reviewer_notes: 'cotton t-shirt' },
    });
    expect(withCode.statusCode).toBe(200);
    const body = withCode.json() as { status: string; reviewer_code: string; reviewer_notes: string };
    expect(body.status).toBe('resolved');
    expect(body.reviewer_code).toBe('610910000000');
    expect(body.reviewer_notes).toBe('cotton t-shirt');
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
