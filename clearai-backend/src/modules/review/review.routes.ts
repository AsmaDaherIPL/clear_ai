/**
 * Review queue endpoints. Internal DB tables still use `hitl_queue`;
 * the API surface uses `/classifications/review`.
 *
 *   GET    /classifications/review              list with filters
 *   GET    /classifications/review/:id          single row + flattened candidates
 *   PATCH  /classifications/review/:id          decide (approve|override|reject|block_from_submission)
 *   POST   /classifications/review/:id/claim    pending → in_review (V2-only, kept in code)
 *
 * State machine (enforced via SQL WHERE clauses):
 *   pending → in_review                        (POST /claim)
 *   pending | in_review → resolved             (PATCH approve|override|block_from_submission)
 *   pending | in_review → dismissed            (PATCH reject)
 *   resolved | dismissed → terminal            (409)
 *
 * Decision verbs:
 *
 *   approve                  Pipeline got it right. final_code unchanged.
 *   override                 Pipeline picked wrong code; reviewer supplies the
 *                            right one. Patches declaration_run_items.final_code
 *                            and preserves the original in pipeline_final_code.
 *                            GATED: only allowed when current confidence < 0.60
 *                            (any value at or above is auto-rejected with 403).
 *                            reviewer_code must be one of the picker's
 *                            annotated_candidates by default; pass force=true
 *                            to bypass with an audit flag on the queue row.
 *   reject                   Reviewer can't decide; dismiss the review row,
 *                            keep the pipeline's final_code untouched.
 *   block_from_submission    Reviewer decided this row should not be filed.
 *                            Sets excluded_from_xml=true on the row and marks
 *                            it 'blocked'. reviewer_notes required (min 10
 *                            chars). reviewer_code MUST NOT be supplied.
 *                            Allowed on ANY review row regardless of reason.
 *
 * Override side-effect: when decide.decision='override' (with a 12-digit
 * reviewer_code), the handler patches declaration_run_items in the same
 * transaction:
 *   pipeline_final_code := current final_code  (only if NULL — preserve original)
 *   final_code         := reviewer_code
 *   final_code_source  := 'reviewer_override'
 *
 * Block side-effect: when decide.decision='block_from_submission':
 *   status              := 'blocked'
 *   excluded_from_xml   := true
 *   blocked_at          := now()
 *   blocked_reason      := 'reviewer_decision'
 *   blocked_by          := reviewed_by  (null until user identity wired)
 *
 * `reviewed_by` is NULL until a user identity is wired (V2 multi-reviewer).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool } from '../../db/client.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Confidence at or above this is treated as "the pipeline is fairly
 * confident — don't allow free-form overrides on this row." Aligned
 * with IDENTIFY_LOW_CONFIDENCE_HITL_THRESHOLD in the orchestrator: the
 * pipeline already auto-routes anything < 0.60 to review, so the only
 * rows that REACH review with confidence >= 0.60 are sanity_flag rows
 * (sanity disagreed with the code's plausibility, but the picker was
 * confident) or verifier_uncertain rows. In both cases the picker's
 * verdict is auditable enough that a reviewer should either approve
 * or block — not silently override.
 *
 * Reviewers can still override these rows when retrieval was bad: pass
 * { force: true } in the body. That records an audit flag on the queue
 * row for downstream analysis.
 */
const OVERRIDE_CONFIDENCE_GATE = 0.60;

/**
 * Minimum length of reviewer_notes when blocking from submission. A
 * one-line note is required because block is destructive (the row is
 * removed from the customs declaration). The min-char rule forces the
 * reviewer to actually type a reason rather than just clicking through.
 */
const BLOCK_NOTES_MIN_LENGTH = 10;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const StatusEnum = z.enum(['pending', 'in_review', 'resolved', 'dismissed']);
// Widened from ['verdict_escalate', 'sanity_flag', 'low_information'] to
// include 'verifier_uncertain' — the orchestrator has been emitting this
// reason since PR 12 but the filter enum lagged. DB CHECK already allows
// it (migration 0079).
const ReasonEnum = z.enum([
  'verdict_escalate',
  'sanity_flag',
  'low_information',
  'verifier_uncertain',
]);

// UUIDv7 strict — matches what newId() mints.
const UuidV7Schema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, {
    message: 'must be a UUIDv7',
  });

// GET /classifications/review query params. operator_slug filter dropped
// in the 2026-05-12 cutover — single-operator V1.
//
// item_id filter (added 2026-05-16): lets the SPA's inline-review entry
// points (BatchResultsTable / ResultSingle) navigate from a results row
// to the open queue row for that item. Typical use:
//
//   GET /classifications/review?item_id=<dri.id>&status=pending&limit=1
//
// to resolve dri.id -> hitl_queue.id without exposing the queue's
// internal ID on the results screen.
const ListQuery = z.object({
  status: StatusEnum.optional(),
  reason: ReasonEnum.optional(),
  batch_id: UuidV7Schema.optional(),
  item_id: UuidV7Schema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

const IdParam = z.object({
  id: UuidV7Schema,
});

// PATCH /classifications/review/:id body. Cross-field rules enforced via
// .superRefine() so error messages can point at the right field:
//
//   decision='override' → reviewer_code required (12 digits). reviewer_code
//     must be in trace.annotated_candidates UNLESS force=true. Confidence
//     gate (< 0.60) checked in the handler (needs DB lookup).
//   decision='block_from_submission' → reviewer_notes required (≥ 10 chars).
//     reviewer_code FORBIDDEN.
//   decision='approve' / 'reject' → reviewer_code FORBIDDEN.
const DecideBody = z
  .object({
    decision: z.enum(['approve', 'override', 'reject', 'block_from_submission']),
    reviewer_code: z
      .string()
      .regex(/^\d{12}$/, 'reviewer_code must be exactly 12 digits')
      .optional(),
    reviewer_notes: z.string().max(2000).optional(),
    /**
     * Bypass the candidate-set constraint on `reviewer_code`. Default is
     * candidate-constrained (the picker's annotated_candidates are the
     * universe). Setting force=true allows the reviewer to type any
     * valid 12-digit code that exists in zatca_hs_codes (active, not
     * deleted) — used when retrieval missed the right answer. The queue
     * row gets reviewer_decision='override' with an audit hint that this
     * was an out-of-candidate-set decision (recorded by appending to
     * reviewer_notes in the handler; the field itself stays single-source).
     */
    force: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.decision === 'override') {
      if (!data.reviewer_code) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['reviewer_code'],
          message: "decision='override' requires reviewer_code (12 digits)",
        });
      }
    }
    if (data.decision === 'block_from_submission') {
      if (!data.reviewer_notes || data.reviewer_notes.trim().length < BLOCK_NOTES_MIN_LENGTH) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['reviewer_notes'],
          message: `decision='block_from_submission' requires reviewer_notes (≥ ${BLOCK_NOTES_MIN_LENGTH} chars)`,
        });
      }
      if (data.reviewer_code) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['reviewer_code'],
          message: "decision='block_from_submission' must not include reviewer_code",
        });
      }
    }
    if ((data.decision === 'approve' || data.decision === 'reject') && data.reviewer_code) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reviewer_code'],
        message: `decision='${data.decision}' must not include reviewer_code`,
      });
    }
    if (data.decision !== 'override' && data.force === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['force'],
        message: "force=true is only meaningful for decision='override'",
      });
    }
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
  reason: 'verdict_escalate' | 'sanity_flag' | 'low_information' | 'verifier_uncertain';
  status: 'pending' | 'in_review' | 'resolved' | 'dismissed';
  reviewed_at: string | null;
  reviewed_by: string | null;
  reviewer_decision: 'approve' | 'override' | 'reject' | 'block_from_submission' | null;
  reviewer_code: string | null;
  reviewer_notes: string | null;
}

interface QueueRowWithPayload extends QueueRow {
  payload: unknown;
}

/**
 * One row per candidate the picker evaluated. Flattened from
 * trace.meta.pick.annotated_candidates into the GET /:id response so the
 * UI doesn't have to dig through the trace.
 */
interface FlattenedCandidate {
  code: string;
  description_en: string | null;
  description_ar: string | null;
  fit: 'fits' | 'partial' | 'does_not_fit';
  rationale: string;
  source_arm: string;
  rerank_score: number;
  /** True when this candidate's code equals the current final_code. */
  is_current: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the picker's annotated_candidates from a trace JSONB. Returns
 * an empty array when the trace is missing the field (e.g. parse-reject
 * rows, scope-escalate rows). Defensive: only accepts the canonical
 * shape `{ meta: { pick: { annotated_candidates: [...] } } }` written by
 * dispatch.use-case.ts.
 */
function extractCandidates(
  trace: unknown,
  currentCode: string | null,
): FlattenedCandidate[] {
  if (trace === null || typeof trace !== 'object') return [];
  const meta = (trace as { meta?: unknown }).meta;
  if (meta === null || typeof meta !== 'object' || meta === undefined) return [];
  const pick = (meta as { pick?: unknown }).pick;
  if (pick === null || typeof pick !== 'object' || pick === undefined) return [];
  const annotated = (pick as { annotated_candidates?: unknown }).annotated_candidates;
  if (!Array.isArray(annotated)) return [];
  const out: FlattenedCandidate[] = [];
  for (const c of annotated) {
    if (c === null || typeof c !== 'object') continue;
    const obj = c as Record<string, unknown>;
    if (typeof obj.code !== 'string') continue;
    const fit = obj.fit;
    if (fit !== 'fits' && fit !== 'partial' && fit !== 'does_not_fit') continue;
    out.push({
      code: obj.code,
      description_en: typeof obj.description_en === 'string' ? obj.description_en : null,
      description_ar: typeof obj.description_ar === 'string' ? obj.description_ar : null,
      fit,
      rationale: typeof obj.rationale === 'string' ? obj.rationale : '',
      source_arm: typeof obj.source_arm === 'string' ? obj.source_arm : 'unknown',
      rerank_score: typeof obj.rerank_score === 'number' ? obj.rerank_score : 0,
      is_current: currentCode !== null && obj.code === currentCode,
    });
  }
  return out;
}

/**
 * Extract the picker's confidence from a trace JSONB. Returns null when
 * the pick stage didn't run (escalate rows) or the trace shape is
 * unexpected. Used for the override confidence gate.
 */
function extractConfidence(trace: unknown): number | null {
  if (trace === null || typeof trace !== 'object') return null;
  const meta = (trace as { meta?: unknown }).meta;
  if (meta === null || typeof meta !== 'object' || meta === undefined) return null;
  const pick = (meta as { pick?: unknown }).pick;
  if (pick === null || typeof pick !== 'object' || pick === undefined) return null;
  const kind = (pick as { kind?: unknown }).kind;
  if (kind !== 'accepted') return null;
  const conf = (pick as { confidence?: unknown }).confidence;
  return typeof conf === 'number' ? conf : null;
}

/**
 * Extract the sanity verdict + rationale from a trace JSONB.
 */
function extractSanity(trace: unknown): { verdict: string | null; rationale: string | null } {
  if (trace === null || typeof trace !== 'object') return { verdict: null, rationale: null };
  const meta = (trace as { meta?: unknown }).meta;
  if (meta === null || typeof meta !== 'object' || meta === undefined) {
    return { verdict: null, rationale: null };
  }
  const sanity = (meta as { sanity?: unknown }).sanity;
  if (sanity === null || typeof sanity !== 'object' || sanity === undefined) {
    return { verdict: null, rationale: null };
  }
  const verdict = (sanity as { verdict?: unknown }).verdict;
  const rationale = (sanity as { rationale?: unknown }).rationale;
  return {
    verdict: typeof verdict === 'string' ? verdict : null,
    rationale: typeof rationale === 'string' ? rationale : null,
  };
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
    const { status, reason, batch_id, item_id, limit, offset } = parsed.data;

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
    if (item_id) {
      args.push(item_id);
      where.push(`item_id = $${args.length}`);
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

  // GET /classifications/review/:id — single row + flattened candidates
  //
  // Returns the queue row + reviewer-facing decision context:
  //   - current_final_code               from declaration_run_items.final_code
  //   - current_classification_confidence from trace.meta.pick.confidence
  //   - current_sanity_verdict           from trace.meta.sanity.verdict
  //   - current_sanity_rationale         from trace.meta.sanity.rationale
  //   - candidates[]                     flattened picker annotated_candidates
  //                                      (with is_current marker)
  //   - can_override                     true when confidence < 0.60
  //   - can_block_from_submission        always true on open reviews
  //   - payload                          full trace (unchanged)
  app.get<{ Params: { id: string } }>('/classifications/review/:id', async (req, reply) => {
    const parsed = IdParam.safeParse(req.params);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'invalid_id', message: 'id must be a UUIDv7.' },
      });
    }
    const { id } = parsed.data;

    const pool = getPool();
    // Join declaration_run_items so the reviewer-facing UI can render
    // current state (final_code, excluded_from_xml) without a second
    // fetch. LEFT JOIN because single-shot reviews have no DRI row.
    const r = await pool.query<
      QueueRowWithPayload & {
        current_final_code: string | null;
        excluded_from_xml: boolean | null;
        item_trace: unknown;
      }
    >(
      `SELECT q.id, q.created_at, q.enqueued_at, q.classification_event_id,
              q.batch_id, q.item_id, q.operator_slug, q.reason, q.status,
              q.reviewed_at, q.reviewed_by, q.reviewer_decision,
              q.reviewer_code, q.reviewer_notes, q.payload,
              i.final_code              AS current_final_code,
              i.excluded_from_xml       AS excluded_from_xml,
              i.trace                   AS item_trace
         FROM hitl_queue q
         LEFT JOIN declaration_run_items i ON i.id = q.item_id
        WHERE q.id = $1
        LIMIT 1`,
      [id],
    );
    if (r.rowCount === 0) {
      return reply.code(404).send({
        error: { code: 'not_found', message: `No review row with id ${id}.` },
      });
    }
    const row = r.rows[0]!;

    const candidates = extractCandidates(row.item_trace, row.current_final_code);
    const confidence = extractConfidence(row.item_trace);
    const sanity = extractSanity(row.item_trace);
    const isOpen = row.status === 'pending' || row.status === 'in_review';
    // can_override gate: only meaningful on open rows AND when confidence
    // is below the threshold. A high-confidence row gets `can_override:
    // false` so the UI greys out the radio list; the reviewer can still
    // POST with force=true to bypass.
    const canOverride =
      isOpen &&
      confidence !== null &&
      confidence < OVERRIDE_CONFIDENCE_GATE;

    // Strip item_trace + excluded_from_xml from the wire shape; they
    // were only fetched for derivation. Surface the derived fields and
    // keep the original `payload` (full trace) for advanced views.
    const { item_trace: _itemTrace, excluded_from_xml: _excludedFromXml, ...queueFields } = row;
    void _itemTrace;
    void _excludedFromXml;
    return reply.code(200).send({
      ...queueFields,
      current_final_code: row.current_final_code,
      current_classification_confidence: confidence,
      current_sanity_verdict: sanity.verdict,
      current_sanity_rationale: sanity.rationale,
      can_override: canOverride,
      can_block_from_submission: isOpen,
      candidates,
    });
  });

  // PATCH /classifications/review/:id — decide
  //
  // Replaces the old POST /hitl/queue/:id/review. Override flow patches
  // declaration_run_items.final_code transactionally so the batch items
  // table reflects the reviewer's decision immediately. Block flow sets
  // excluded_from_xml=true on the row (no XML rendering today; the
  // column is recorded for the future XML builder).
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
    const { decision, reviewer_code, reviewer_notes, force } = bodyParse.data;

    const pool = getPool();

    // ---- Pre-decision validation that needs DB lookups ----
    //
    // For override: enforce the 0.60 confidence gate + the candidate-set
    // constraint. Both checks read from the persisted item trace (the
    // pre-review snapshot — review payload could be stale if the row
    // was re-classified, but in practice DRI.trace is immutable post-
    // dispatch). We do these BEFORE opening a transaction so we can fail
    // fast with a clean status code.
    //
    // For block: no pre-check; reviewer_notes / no-reviewer_code already
    // enforced by zod superRefine.
    if (decision === 'override') {
      const itemPreview = await pool.query<{
        final_code: string | null;
        trace: unknown;
      }>(
        `SELECT i.final_code, i.trace
           FROM hitl_queue q
           LEFT JOIN declaration_run_items i ON i.id = q.item_id
          WHERE q.id = $1
          LIMIT 1`,
        [id],
      );
      // If hitl_queue row missing, fall through to the main UPDATE which
      // emits the proper 404. If declaration_run_items row missing
      // (single-shot review), there's no trace to check candidates
      // against — accept the override unconditionally on the queue row
      // alone, but the side effect (DRI patch) will no-op as before.
      if (itemPreview.rowCount === 1 && itemPreview.rows[0]!.trace !== null) {
        const trace = itemPreview.rows[0]!.trace;
        const confidence = extractConfidence(trace);
        if (
          confidence !== null &&
          confidence >= OVERRIDE_CONFIDENCE_GATE &&
          force !== true
        ) {
          return reply.code(403).send({
            error: {
              code: 'override_not_allowed_high_confidence',
              message:
                `Pipeline confidence ${confidence.toFixed(2)} is at or above the ${OVERRIDE_CONFIDENCE_GATE.toFixed(2)} override gate. ` +
                `Approve, reject, or block_from_submission instead. ` +
                `Pass { "force": true } to override anyway (audit-logged).`,
              details: { confidence, gate: OVERRIDE_CONFIDENCE_GATE },
            },
          });
        }
        const candidates = extractCandidates(trace, itemPreview.rows[0]!.final_code);
        const candidateCodes = new Set(candidates.map((c) => c.code));
        if (
          candidateCodes.size > 0 &&
          !candidateCodes.has(reviewer_code!) &&
          force !== true
        ) {
          return reply.code(422).send({
            error: {
              code: 'reviewer_code_not_in_candidates',
              message:
                `reviewer_code ${reviewer_code} is not among the picker's evaluated candidates. ` +
                `Pick one of the offered codes, or pass { "force": true } to override outside the candidate set (audit-logged).`,
              details: { reviewer_code, candidate_codes: Array.from(candidateCodes) },
            },
          });
        }
        // force=true path: verify the code at least exists in the
        // codebook (active, not deleted) so we don't write a garbage
        // override. Empty candidate-set rows (low_information escalate)
        // also fall through to this check.
        if (force === true || candidateCodes.size === 0) {
          const exists = await pool.query<{ code: string }>(
            `SELECT code FROM zatca_hs_codes
              WHERE code = $1 AND is_deleted = false
              LIMIT 1`,
            [reviewer_code],
          );
          if (exists.rowCount === 0) {
            return reply.code(422).send({
              error: {
                code: 'reviewer_code_not_in_codebook',
                message:
                  `reviewer_code ${reviewer_code} does not exist in zatca_hs_codes (or is deleted). ` +
                  `An override must point to a valid active code.`,
                details: { reviewer_code },
              },
            });
          }
        }
      }
    }

    // ---- Apply the decision ----
    const newStatus = decision === 'reject' ? 'dismissed' : 'resolved';
    const codeToStore = decision === 'override' ? reviewer_code! : null;
    // When force-override is used, prepend an audit marker to
    // reviewer_notes so the queue row preserves a single-source record
    // of "this was an out-of-candidate-set override". Doesn't replace
    // operator notes — just prepends.
    const auditedNotes =
      decision === 'override' && force === true
        ? `[force_override_outside_candidate_set] ${reviewer_notes ?? ''}`.trim()
        : (reviewer_notes ?? null);

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
        [id, newStatus, decision, codeToStore, auditedNotes],
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

      // ---- Override side effect: patch declaration_run_items ----
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
      }

      // ---- Block side effect: flip declaration_run_items.excluded_from_xml ----
      let itemBlocked: {
        item_id: string;
        previous_status: string;
        excluded_from_xml: boolean;
      } | null = null;

      if (decision === 'block_from_submission') {
        // Single-shot reviews don't have a DRI row — only the queue row
        // is updated, and the API still reports success. The block has
        // no downstream effect in that case (single-shot results aren't
        // filed through the batch XML pipeline).
        const itemRes = await client.query<{ status: string }>(
          `UPDATE declaration_run_items
              SET status = 'blocked',
                  excluded_from_xml = true,
                  blocked_at = now(),
                  blocked_reason = 'reviewer_decision',
                  blocked_by = $2,
                  updated_at = now()
            WHERE id = $1
            RETURNING status`,
          [queueRow.item_id, queueRow.reviewed_by],
        );
        if (itemRes.rowCount === 1) {
          itemBlocked = {
            item_id: queueRow.item_id,
            previous_status: itemRes.rows[0]!.status,
            excluded_from_xml: true,
          };
        }
      }

      await client.query('COMMIT');

      const response: QueueRow & {
        item_patched?: typeof itemPatched;
        item_blocked?: typeof itemBlocked;
      } = { ...queueRow };
      if (itemPatched) response.item_patched = itemPatched;
      if (itemBlocked) response.item_blocked = itemBlocked;
      return reply.code(200).send(response);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  // POST /classifications/review/:id/claim — V2-only state transition
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
