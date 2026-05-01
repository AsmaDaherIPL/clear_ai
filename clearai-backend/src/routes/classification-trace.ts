/**
 * GET /classifications/:id and POST /classifications/:id/feedback —
 * trace replay and one feedback row per (event_id, user_id) via UPSERT.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool } from '../db/client.js';

const idSchema = z.string().uuid({ message: 'classification id must be a UUID' });

const feedbackBody = z.object({
  kind: z.enum(['confirm', 'reject', 'prefer_alternative']),
  /**
   * The 12-digit code being rejected. We accept it but cross-check against
   * the event's chosen_code; if they don't match we still record the
   * feedback (the user might be confused which code was shipped — better
   * to log than reject). Optional because `confirm` doesn't carry one.
   */
  rejected_code: z
    .string()
    .regex(/^\d{12}$/, 'rejected_code must be exactly 12 digits')
    .optional(),
  /** The 12-digit code the user thinks is correct. Required for prefer_alternative. */
  corrected_code: z
    .string()
    .regex(/^\d{12}$/, 'corrected_code must be exactly 12 digits')
    .optional(),
  /** Free-text reason; capped to keep the table healthy. */
  reason: z.string().max(500).optional(),
  /**
   * Optional client-side identifier. Today we don't have auth so this is
   * always null on the wire; populated server-side from auth context once
   * that lands.
   */
  user_id: z.string().min(1).max(200).optional(),
});

export async function classificationTraceRoute(app: FastifyInstance): Promise<void> {
  app.get('/classifications/:id', async (req, reply) => {
    const parse = idSchema.safeParse((req.params as { id?: string }).id);
    if (!parse.success) {
      return reply.code(404).send({ error: 'not_found', detail: 'invalid classification id' });
    }
    const id = parse.data;

    const pool = getPool();
    const eventRes = await pool.query<{
      id: string;
      created_at: Date;
      endpoint: string;
      request: unknown;
      language_detected: string | null;
      decision_status: string;
      decision_reason: string;
      confidence_band: string | null;
      chosen_code: string | null;
      alternatives: unknown;
      top_retrieval_score: number | null;
      top2_gap: number | null;
      candidate_count: number | null;
      branch_size: number | null;
      llm_used: boolean;
      llm_status: string | null;
      guard_tripped: boolean;
      model_calls: unknown;
      embedder_version: string | null;
      llm_model: string | null;
      total_latency_ms: number | null;
      error: string | null;
      rationale: string | null;
    }>(`SELECT * FROM classification_events WHERE id = $1`, [id]);

    if (eventRes.rowCount === 0) {
      return reply.code(404).send({ error: 'not_found', detail: 'no classification with that id' });
    }
    const e = eventRes.rows[0]!;

    const fbRes = await pool.query<{
      id: string;
      created_at: Date;
      updated_at: Date;
      kind: string;
      rejected_code: string | null;
      corrected_code: string | null;
      reason: string | null;
      user_id: string | null;
    }>(
      `SELECT id, created_at, updated_at, kind, rejected_code, corrected_code, reason, user_id
       FROM classification_feedback
       WHERE event_id = $1
       ORDER BY created_at DESC`,
      [id],
    );

    return {
      event: {
        id: e.id,
        created_at: e.created_at,
        endpoint: e.endpoint,
        request: e.request,
        language_detected: e.language_detected,
        decision_status: e.decision_status,
        decision_reason: e.decision_reason,
        confidence_band: e.confidence_band,
        chosen_code: e.chosen_code,
        alternatives: e.alternatives,
        top_retrieval_score: e.top_retrieval_score,
        top2_gap: e.top2_gap,
        candidate_count: e.candidate_count,
        branch_size: e.branch_size,
        llm_used: e.llm_used,
        llm_status: e.llm_status,
        guard_tripped: e.guard_tripped,
        model_calls: e.model_calls,
        embedder_version: e.embedder_version,
        llm_model: e.llm_model,
        total_latency_ms: e.total_latency_ms,
        error: e.error,
        rationale: e.rationale,
      },
      feedback: fbRes.rows,
    };
  });

  app.post('/classifications/:id/feedback', async (req, reply) => {
    const idParse = idSchema.safeParse((req.params as { id?: string }).id);
    if (!idParse.success) {
      return reply.code(404).send({ error: 'not_found', detail: 'invalid classification id' });
    }
    const id = idParse.data;

    const bodyParse = feedbackBody.safeParse(req.body);
    if (!bodyParse.success) {
      return reply
        .code(400)
        .send({ error: 'invalid_body', detail: bodyParse.error.flatten() });
    }
    const body = bodyParse.data;

    // Cross-check the event exists. Cheap query and avoids FK errors from
    // surfacing as 500s.
    const pool = getPool();
    const exists = await pool.query<{ chosen_code: string | null }>(
      `SELECT chosen_code FROM classification_events WHERE id = $1`,
      [id],
    );
    if (exists.rowCount === 0) {
      return reply.code(404).send({ error: 'not_found', detail: 'no classification with that id' });
    }

    // Constraint enforcement that's clearer here than in the SQL CHECK:
    //   - prefer_alternative requires corrected_code
    //   - confirm forbids both rejected_code and corrected_code
    if (body.kind === 'prefer_alternative' && !body.corrected_code) {
      return reply
        .code(400)
        .send({ error: 'invalid_body', detail: 'prefer_alternative requires corrected_code' });
    }
    if (body.kind === 'confirm' && body.corrected_code) {
      return reply
        .code(400)
        .send({ error: 'invalid_body', detail: 'confirm cannot carry corrected_code' });
    }

    // Default the rejected_code to the event's chosen code when the user
    // didn't supply one — that's the typical "this is wrong" click on the
    // result card.
    const rejectedCode = body.rejected_code ?? exists.rows[0]?.chosen_code ?? null;

    // UPSERT on (event_id, user_id) — one feedback row per user per event.
    // user_id null is a single bucket today; once auth lands every user
    // gets their own slot.
    const userId = body.user_id ?? null;
    const r = await pool.query<{ id: string }>(
      `INSERT INTO classification_feedback (event_id, kind, rejected_code, corrected_code, reason, user_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (event_id, COALESCE(user_id, ''))
       DO UPDATE SET
         kind           = EXCLUDED.kind,
         rejected_code  = EXCLUDED.rejected_code,
         corrected_code = EXCLUDED.corrected_code,
         reason         = EXCLUDED.reason,
         updated_at     = now()
       RETURNING id`,
      [
        id,
        body.kind,
        rejectedCode,
        body.corrected_code ?? null,
        body.reason ?? null,
        userId,
      ],
    );

    return { ok: true, feedback_id: r.rows[0]?.id ?? null };
  });
}
