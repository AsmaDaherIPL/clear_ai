/**
 * POST /classifications/{id}/submission-description — generate ZATCA-grade
 * Arabic submission text on demand from a stored accepted classification.
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

    // Only accepted 12-digit-leaf classifications can produce a submission.
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

    // Researched inputs carry `rewritten_as`; everything else uses `description`.
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
      return reply.code(500).send({ error: 'generation_failed' });
    }

    return {
      description_ar: result.descriptionAr,
      description_en: result.descriptionEn,
      source: result.invoked,
    };
  });
}
