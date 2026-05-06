/**
 * POST /submission-description — generate the ZATCA goods description
 * (≤300 char Arabic) for an item, given its description + chosen HS code.
 *
 * Body: { description: string, code: string }
 * Returns: { description_ar: string, source: 'llm' | 'llm_failed' | 'fallback' }
 *
 * Useful for testing the submission-description LLM in isolation, and for
 * any UI that needs to (re-)generate the Arabic for a single item.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool } from '../../../db/client.js';
import { generateSubmissionDescription } from './submission-description.js';

const Body = z.object({
  description: z.string().min(1).max(2000),
  code: z.string().regex(/^\d{12}$/, 'HS code must be exactly 12 digits'),
});

interface CatalogRow {
  description_ar: string | null;
}

export async function submissionDescriptionRoute(app: FastifyInstance): Promise<void> {
  app.post('/submission-description', async (req, reply) => {
    const parse = Body.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send({ error: 'invalid_body', detail: parse.error.flatten() });
    }
    const { description, code } = parse.data;

    const pool = getPool();
    const catRes = await pool.query<CatalogRow>(
      `SELECT description_ar FROM zatca_hs_codes WHERE code = $1`,
      [code],
    );
    if (catRes.rowCount === 0) {
      return reply.code(404).send({ error: 'unknown_code', detail: `HS code ${code} not found` });
    }

    const result = await generateSubmissionDescription({
      cleanedDescription: description,
      chosenCode: code,
      catalogDescriptionAr: catRes.rows[0]?.description_ar ?? null,
    });

    return {
      description_ar: result.descriptionAr,
      source: result.invoked,
      latency_ms: result.latencyMs,
    };
  });
}
