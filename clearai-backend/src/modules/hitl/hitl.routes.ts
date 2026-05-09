/**
 * State machine enforced in SQL by the WHERE clauses below:
 *   pending → in_review              (/claim)
 *   pending | in_review → resolved   (/review approve|override)
 *   pending | in_review → dismissed  (/review reject)
 *   resolved | dismissed → terminal  (returns 409)
 *
 * `reviewed_by` is NULL until the BFF stamps a user header on
 * incoming requests; intentional gap for v0.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool } from '../../db/client.js';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const StatusEnum = z.enum(['pending', 'in_review', 'resolved', 'dismissed']);

const ListQuery = z.object({
  status: StatusEnum.optional(),
  operator_slug: z
    .string()
    .regex(/^[a-z][a-z0-9_]{2,31}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

const IdParam = z.object({
  id: z.string().uuid(),
});

const ReviewBody = z.object({
  decision: z.enum(['approve', 'override', 'reject']),
  /** Required when decision='override'. Ignored otherwise. */
  reviewer_code: z
    .string()
    .regex(/^\d{12}$/)
    .optional(),
  reviewer_notes: z.string().max(2000).optional(),
});

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface QueueRow {
  id: string;
  created_at: string;
  enqueued_at: string;
  classification_event_id: string;
  item_id: string;
  operator_slug: string;
  reason: 'verdict_escalate' | 'sanity_flag';
  status: 'pending' | 'in_review' | 'resolved' | 'dismissed';
  reviewed_at: string | null;
  reviewed_by: string | null;
  reviewer_decision: 'approve' | 'override' | 'reject' | null;
  reviewer_code: string | null;
  reviewer_notes: string | null;
}

interface QueueRowWithPayload extends QueueRow {
  payload: unknown;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function hitlRoutes(app: FastifyInstance): Promise<void> {
  // --- GET /hitl/queue ---
  app.get('/hitl/queue', async (req, reply) => {
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'invalid_query', message: 'Query validation failed.', details: parsed.error.flatten() },
      });
    }
    const { status, operator_slug, limit, offset } = parsed.data;

    const pool = getPool();
    const where: string[] = [];
    const args: unknown[] = [];
    if (status) {
      args.push(status);
      where.push(`status = $${args.length}`);
    }
    if (operator_slug) {
      args.push(operator_slug);
      where.push(`operator_slug = $${args.length}`);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    args.push(limit);
    args.push(offset);

    const r = await pool.query<QueueRow>(
      `SELECT id, created_at, enqueued_at, classification_event_id, item_id,
              operator_slug, reason, status,
              reviewed_at, reviewed_by, reviewer_decision, reviewer_code, reviewer_notes
         FROM hitl_queue
         ${whereSql}
         ORDER BY created_at DESC
         LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args,
    );

    const totalRes = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM hitl_queue ${whereSql}`,
      args.slice(0, where.length),
    );

    return reply.code(200).send({
      items: r.rows,
      total: Number(totalRes.rows[0]?.count ?? 0),
      limit,
      offset,
    });
  });

  // --- GET /hitl/queue/:id ---
  app.get<{ Params: { id: string } }>('/hitl/queue/:id', async (req, reply) => {
    const parsed = IdParam.safeParse(req.params);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'invalid_id', message: 'id must be a UUID.' },
      });
    }
    const { id } = parsed.data;

    const pool = getPool();
    const r = await pool.query<QueueRowWithPayload>(
      `SELECT id, created_at, enqueued_at, classification_event_id, item_id,
              operator_slug, reason, status,
              reviewed_at, reviewed_by, reviewer_decision, reviewer_code, reviewer_notes,
              payload
         FROM hitl_queue
         WHERE id = $1
         LIMIT 1`,
      [id],
    );
    if (r.rowCount === 0) {
      return reply.code(404).send({
        error: { code: 'not_found', message: `No HITL row with id ${id}.` },
      });
    }
    return reply.code(200).send(r.rows[0]);
  });

  // --- POST /hitl/queue/:id/claim ---
  app.post<{ Params: { id: string } }>('/hitl/queue/:id/claim', async (req, reply) => {
    const parsed = IdParam.safeParse(req.params);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'invalid_id', message: 'id must be a UUID.' },
      });
    }
    const { id } = parsed.data;

    const pool = getPool();
    const r = await pool.query<QueueRow>(
      `UPDATE hitl_queue
          SET status = 'in_review'
        WHERE id = $1 AND status = 'pending'
        RETURNING id, created_at, enqueued_at, classification_event_id, item_id,
                  operator_slug, reason, status,
                  reviewed_at, reviewed_by, reviewer_decision, reviewer_code, reviewer_notes`,
      [id],
    );
    if (r.rowCount === 0) {
      // Either the row doesn't exist or it isn't in 'pending' state.
      const exists = await pool.query<{ status: string }>(
        `SELECT status FROM hitl_queue WHERE id = $1`,
        [id],
      );
      if (exists.rowCount === 0) {
        return reply.code(404).send({
          error: { code: 'not_found', message: `No HITL row with id ${id}.` },
        });
      }
      return reply.code(409).send({
        error: {
          code: 'invalid_state',
          message: `Row is in status '${exists.rows[0]!.status}', cannot be claimed.`,
        },
      });
    }
    return reply.code(200).send(r.rows[0]);
  });

  // --- POST /hitl/queue/:id/review ---
  app.post<{ Params: { id: string } }>('/hitl/queue/:id/review', async (req, reply) => {
    const idParse = IdParam.safeParse(req.params);
    if (!idParse.success) {
      return reply.code(400).send({
        error: { code: 'invalid_id', message: 'id must be a UUID.' },
      });
    }
    const bodyParse = ReviewBody.safeParse(req.body);
    if (!bodyParse.success) {
      return reply.code(400).send({
        error: { code: 'invalid_body', message: 'Body validation failed.', details: bodyParse.error.flatten() },
      });
    }
    const { id } = idParse.data;
    const { decision, reviewer_code, reviewer_notes } = bodyParse.data;

    if (decision === 'override' && !reviewer_code) {
      return reply.code(400).send({
        error: {
          code: 'reviewer_code_required',
          message: "decision='override' requires reviewer_code (12 digits).",
        },
      });
    }

    const newStatus = decision === 'reject' ? 'dismissed' : 'resolved';
    const codeToStore = decision === 'override' ? reviewer_code! : null;

    const pool = getPool();
    const r = await pool.query<QueueRow>(
      `UPDATE hitl_queue
          SET status = $2,
              reviewed_at = now(),
              reviewer_decision = $3,
              reviewer_code = $4,
              reviewer_notes = $5
        WHERE id = $1
          AND status IN ('pending', 'in_review')
        RETURNING id, created_at, enqueued_at, classification_event_id, item_id,
                  operator_slug, reason, status,
                  reviewed_at, reviewed_by, reviewer_decision, reviewer_code, reviewer_notes`,
      [id, newStatus, decision, codeToStore, reviewer_notes ?? null],
    );
    if (r.rowCount === 0) {
      const exists = await pool.query<{ status: string }>(
        `SELECT status FROM hitl_queue WHERE id = $1`,
        [id],
      );
      if (exists.rowCount === 0) {
        return reply.code(404).send({
          error: { code: 'not_found', message: `No HITL row with id ${id}.` },
        });
      }
      return reply.code(409).send({
        error: {
          code: 'invalid_state',
          message: `Row is in status '${exists.rows[0]!.status}', cannot be reviewed.`,
        },
      });
    }
    return reply.code(200).send(r.rows[0]);
  });
}
