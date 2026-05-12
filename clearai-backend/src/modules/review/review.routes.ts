/**
 * Review queue endpoints (renamed from /hitl/queue in the 2026-05-12 API
 * cutover). Internal DB tables still use `hitl_queue`; only the API
 * surface uses `/classifications/review`.
 *
 *   GET    /classifications/review              list with filters
 *   GET    /classifications/review/:id          single row + payload
 *   PATCH  /classifications/review/:id          decide (approve|override|reject)
 *   POST   /classifications/review/:id/claim    pending → in_review (V2-only, kept in code)
 *
 * State machine (enforced via SQL WHERE clauses):
 *   pending → in_review                (POST /claim)
 *   pending | in_review → resolved     (PATCH decide: approve|override)
 *   pending | in_review → dismissed    (PATCH decide: reject)
 *   resolved | dismissed → terminal    (409)
 *
 * Override side-effect: when decide.decision='override' (with a 12-digit
 * reviewer_code), the handler patches declaration_run_items in the same
 * transaction:
 *   pipeline_final_code := current final_code  (only if NULL — preserve original)
 *   final_code         := reviewer_code
 *   final_code_source  := 'reviewer_override'
 *
 * `reviewed_by` is NULL until a user identity is wired (V2 multi-reviewer).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool } from '../../db/client.js';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const StatusEnum = z.enum(['pending', 'in_review', 'resolved', 'dismissed']);
const ReasonEnum = z.enum(['verdict_escalate', 'sanity_flag', 'low_information']);

// UUIDv7 strict — matches what newId() mints.
const UuidV7Schema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, {
    message: 'must be a UUIDv7',
  });

// GET /classifications/review query params. operator_slug filter dropped
// in the 2026-05-12 cutover — single-operator V1.
const ListQuery = z.object({
  status: StatusEnum.optional(),
  reason: ReasonEnum.optional(),
  batch_id: UuidV7Schema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

const IdParam = z.object({
  id: UuidV7Schema,
});

// PATCH /classifications/review/:id body. Cross-field rule enforced
// via .refine(): decision='override' requires reviewer_code.
const DecideBody = z
  .object({
    decision: z.enum(['approve', 'override', 'reject']),
    reviewer_code: z
      .string()
      .regex(/^\d{12}$/, 'reviewer_code must be exactly 12 digits')
      .optional(),
    reviewer_notes: z.string().max(2000).optional(),
  })
  .refine((data) => data.decision !== 'override' || !!data.reviewer_code, {
    message: "decision='override' requires reviewer_code (12 digits)",
    path: ['reviewer_code'],
  });

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface QueueRow {
  id: string;
  created_at: string;
  enqueued_at: string;
  classification_event_id: string;
  /** Batch context. NULL for single-shot dispatches. */
  batch_id: string | null;
  item_id: string;
  operator_slug: string;
  reason: 'verdict_escalate' | 'sanity_flag' | 'low_information';
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

export async function reviewRoutes(app: FastifyInstance): Promise<void> {
  // GET /classifications/review — list with filters
  app.get('/classifications/review', async (req, reply) => {
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'invalid_query', message: 'Query validation failed.', details: parsed.error.flatten() },
      });
    }
    const { status, reason, batch_id, limit, offset } = parsed.data;

    const pool = getPool();
    const where: string[] = [];
    const args: unknown[] = [];
    if (status) {
      args.push(status);
      where.push(`status = $${args.length}`);
    }
    if (reason) {
      args.push(reason);
      where.push(`reason = $${args.length}`);
    }
    if (batch_id) {
      args.push(batch_id);
      where.push(`batch_id = $${args.length}`);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    args.push(limit);
    args.push(offset);

    const r = await pool.query<QueueRow>(
      `SELECT id, created_at, enqueued_at, classification_event_id, batch_id, item_id,
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
    const total = Number(totalRes.rows[0]?.count ?? 0);
    const fetched = offset + r.rows.length;
    const hasMore = fetched < total;

    return reply.code(200).send({
      items: r.rows,
      total,
      limit,
      offset,
      has_more: hasMore,
      next_offset: hasMore ? fetched : null,
    });
  });

  // GET /classifications/review/:id — single row + payload
  app.get<{ Params: { id: string } }>('/classifications/review/:id', async (req, reply) => {
    const parsed = IdParam.safeParse(req.params);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'invalid_id', message: 'id must be a UUIDv7.' },
      });
    }
    const { id } = parsed.data;

    const pool = getPool();
    const r = await pool.query<QueueRowWithPayload>(
      `SELECT id, created_at, enqueued_at, classification_event_id, batch_id, item_id,
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
        error: { code: 'not_found', message: `No review row with id ${id}.` },
      });
    }
    return reply.code(200).send(r.rows[0]);
  });

  // PATCH /classifications/review/:id — decide
  //
  // Replaces the old POST /hitl/queue/:id/review. Override flow now
  // patches declaration_run_items.final_code transactionally so the
  // batch items table reflects the reviewer's decision immediately,
  // and `pipeline_final_code` captures the auto-classified code for
  // audit.
  app.patch<{ Params: { id: string } }>('/classifications/review/:id', async (req, reply) => {
    const idParse = IdParam.safeParse(req.params);
    if (!idParse.success) {
      return reply.code(400).send({
        error: { code: 'invalid_id', message: 'id must be a UUIDv7.' },
      });
    }
    const bodyParse = DecideBody.safeParse(req.body);
    if (!bodyParse.success) {
      return reply.code(400).send({
        error: { code: 'invalid_body', message: 'Body validation failed.', details: bodyParse.error.flatten() },
      });
    }
    const { id } = idParse.data;
    const { decision, reviewer_code, reviewer_notes } = bodyParse.data;

    const newStatus = decision === 'reject' ? 'dismissed' : 'resolved';
    const codeToStore = decision === 'override' ? reviewer_code! : null;

    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Update the queue row first. If the row is already terminal or
      // doesn't exist, this returns 0 rows and we roll back.
      const updateRes = await client.query<QueueRow>(
        `UPDATE hitl_queue
            SET status = $2,
                reviewed_at = now(),
                reviewer_decision = $3,
                reviewer_code = $4,
                reviewer_notes = $5
          WHERE id = $1
            AND status IN ('pending', 'in_review')
          RETURNING id, created_at, enqueued_at, classification_event_id, batch_id, item_id,
                    operator_slug, reason, status,
                    reviewed_at, reviewed_by, reviewer_decision, reviewer_code, reviewer_notes`,
        [id, newStatus, decision, codeToStore, reviewer_notes ?? null],
      );

      if (updateRes.rowCount === 0) {
        await client.query('ROLLBACK');
        const exists = await pool.query<{ status: string }>(
          `SELECT status FROM hitl_queue WHERE id = $1`,
          [id],
        );
        if (exists.rowCount === 0) {
          return reply.code(404).send({
            error: { code: 'not_found', message: `No review row with id ${id}.` },
          });
        }
        return reply.code(409).send({
          error: {
            code: 'invalid_state',
            message: `Row is in status '${exists.rows[0]!.status}', cannot be decided.`,
          },
        });
      }

      const queueRow = updateRes.rows[0]!;

      // Override path: patch declaration_run_items. Only fires when the
      // review was sourced from a batch (item_id has a matching row in
      // declaration_run_items). Single-shot reviewers can still set
      // decision='override' on their flagged single classifications but
      // there's no per-item row to update — the override is recorded
      // only in hitl_queue.reviewer_code for those.
      let itemPatched: {
        item_id: string;
        previous_final_code: string | null;
        new_final_code: string;
        final_code_source: 'reviewer_override';
      } | null = null;

      if (decision === 'override') {
        const itemRes = await client.query<{ final_code: string | null; pipeline_final_code: string | null }>(
          `SELECT final_code, pipeline_final_code
             FROM declaration_run_items
            WHERE id = $1
            FOR UPDATE`,
          [queueRow.item_id],
        );
        if (itemRes.rowCount === 1) {
          const row = itemRes.rows[0]!;
          // Preserve the pipeline's original code only on first override.
          // Re-overrides (rare) don't keep overwriting pipeline_final_code.
          const preservePipeline = row.pipeline_final_code === null && row.final_code !== null;

          await client.query(
            `UPDATE declaration_run_items
                SET final_code = $2,
                    final_code_source = 'reviewer_override',
                    pipeline_final_code = COALESCE(pipeline_final_code, $3),
                    updated_at = now()
              WHERE id = $1`,
            [
              queueRow.item_id,
              reviewer_code!,
              preservePipeline ? row.final_code : null,
            ],
          );

          itemPatched = {
            item_id: queueRow.item_id,
            previous_final_code: row.final_code,
            new_final_code: reviewer_code!,
            final_code_source: 'reviewer_override',
          };
        }
        // If no matching declaration_run_items row (single-shot review),
        // we still resolved the queue row; itemPatched stays null and
        // the response just doesn't include the item_patched block.
      }

      await client.query('COMMIT');

      const response: QueueRow & { item_patched?: typeof itemPatched } = { ...queueRow };
      if (itemPatched) {
        response.item_patched = itemPatched;
      }
      return reply.code(200).send(response);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  // POST /classifications/review/:id/claim — V2-only state transition
  //
  // Kept in code (and exposed at the URL) for forward-compat with V2
  // multi-reviewer flows. The V1 review UI doesn't surface a "claim"
  // button — reviewers go straight from pending → PATCH decide.
  app.post<{ Params: { id: string } }>('/classifications/review/:id/claim', async (req, reply) => {
    const parsed = IdParam.safeParse(req.params);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'invalid_id', message: 'id must be a UUIDv7.' },
      });
    }
    const { id } = parsed.data;

    const pool = getPool();
    const r = await pool.query<QueueRow>(
      `UPDATE hitl_queue
          SET status = 'in_review'
        WHERE id = $1 AND status = 'pending'
        RETURNING id, created_at, enqueued_at, classification_event_id, batch_id, item_id,
                  operator_slug, reason, status,
                  reviewed_at, reviewed_by, reviewer_decision, reviewer_code, reviewer_notes`,
      [id],
    );
    if (r.rowCount === 0) {
      const exists = await pool.query<{ status: string }>(
        `SELECT status FROM hitl_queue WHERE id = $1`,
        [id],
      );
      if (exists.rowCount === 0) {
        return reply.code(404).send({
          error: { code: 'not_found', message: `No review row with id ${id}.` },
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
}
