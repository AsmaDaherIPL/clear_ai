/**
 * POST /classifications/{id}/submission-description
 *
 * Generates a customs-grade Arabic description (with EN companion) suitable
 * for the ZATCA item submission form. The classify endpoint used to
 * generate this inline on every accepted classification, which added
 * ~3-5s of Sonnet time to the response. Most users don't need it until
 * they're about to copy text into the customs declaration form, so we
 * generate it on demand from a prior classification's persisted record.
 *
 * Why POST (not GET): even though the operation is read-mostly and
 * deterministic per `id`, every call burns Haiku tokens. POST prevents
 * browsers / proxies / CDNs from auto-replaying the request and stops
 * the URL from leaking into access logs.
 *
 * Inputs:
 *   id (path) — UUID of a prior classification (the `id` returned from
 *               POST /classifications). No body required.
 *
 * Reads the stored event, looks up the chosen code's catalog text, and
 * runs the same Haiku-backed generator. Same deterministic distinctness
 * guard, so the response always differs from the catalog AR — no need
 * for a `differs_from_catalog` flag on the wire.
 *
 * Response:
 *   200 { description_ar, description_en, source: 'llm' | 'guard_fallback' }
 *   404 not_found              — id doesn't exist or is malformed
 *   400 invalid_state          — classification is not on a 12-digit accepted path
 *   500 generation_failed      — generator returned no text (rare)
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool } from '../db/client.js';
import { generateSubmissionDescription } from '../classification/submission-description.js';
import { loadThresholds } from '../catalog/setup-meta.js';

const idSchema = z.string().uuid({ message: 'classification id must be a UUID' });

interface EventRow {
  chosen_code: string | null;
  decision_status: string;
  request: { description?: string; rewritten_as?: string | null } | null;
}

export async function submissionDescriptionRoute(app: FastifyInstance): Promise<void> {
  app.post('/classifications/:id/submission-description', async (req, reply) => {
    const parse = idSchema.safeParse((req.params as { id?: string }).id);
    if (!parse.success) {
      return reply.code(404).send({ error: 'not_found', detail: 'invalid classification id' });
    }
    const id = parse.data;

    const pool = getPool();
    const eventRes = await pool.query<EventRow>(
      `SELECT chosen_code, decision_status, request
         FROM classification_events
        WHERE id = $1`,
      [id],
    );
    if (eventRes.rowCount === 0) {
      return reply.code(404).send({ error: 'not_found', detail: 'no classification with that id' });
    }
    const e = eventRes.rows[0]!;

    // Only accepted, 12-digit-leaf classifications can produce a
    // submission. needs_clarification / best_effort don't have a real
    // catalog row to anchor on, and a partial code can't be declared.
    if (
      e.decision_status !== 'accepted' ||
      !e.chosen_code ||
      !/^\d{12}$/.test(e.chosen_code)
    ) {
      return reply.code(400).send({
        error: 'invalid_state',
        detail: 'submission description only available on accepted 12-digit classifications',
      });
    }

    // Pull the picker's effective description from the stored request.
    // Researched inputs carry `rewritten_as`; everything else uses the
    // original `description`. Both are persisted by logEvent.
    const requestPayload = e.request ?? {};
    const effectiveDescription =
      (typeof requestPayload.rewritten_as === 'string' && requestPayload.rewritten_as) ||
      (typeof requestPayload.description === 'string' && requestPayload.description) ||
      '';

    if (!effectiveDescription) {
      return reply.code(400).send({
        error: 'invalid_state',
        detail: 'classification is missing a description anchor',
      });
    }

    // Catalog text for the chosen code — input to the distinctness guard
    // and reference for the generator.
    const catRes = await pool.query<{
      description_en: string | null;
      description_ar: string | null;
    }>(
      `SELECT description_en, description_ar FROM hs_codes WHERE code = $1`,
      [e.chosen_code],
    );
    const cat = catRes.rows[0] ?? { description_en: null, description_ar: null };

    const t = await loadThresholds();
    const result = await generateSubmissionDescription({
      effectiveDescription,
      chosenCode: e.chosen_code,
      catalogDescriptionAr: cat.description_ar,
      catalogDescriptionEn: cat.description_en,
      opts: {
        enabled: true,
        maxTokens: t.SUBMISSION_DESC_MAX_TOKENS,
      },
    });

    if (result.invoked === 'disabled' || !result.descriptionAr) {
      // disabled is not actually reachable here (we passed enabled:true)
      // but the type-narrowing shape is the same — defensive.
      return reply.code(500).send({ error: 'generation_failed' });
    }

    return {
      description_ar: result.descriptionAr,
      description_en: result.descriptionEn,
      // 'llm' means Haiku produced fluent text; 'guard_fallback' means
      // the prefix-mutator ran (broker should review). The deterministic
      // distinctness guard fires either way, so the AR text is always
      // safe vs catalog match.
      source: result.invoked,
    };
  });
}
