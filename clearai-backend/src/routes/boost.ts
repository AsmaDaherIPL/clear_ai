/**
 * /boost — given a 12-digit declared code, search siblings under the same parent10.
 * If no sibling beats the declared code by BOOST_MARGIN, short-circuit to
 * `already_most_specific`.
 *
 * /boost is mechanical and does NOT use the LLM nor GIRs.
 */
import type { FastifyInstance } from 'fastify';
import { boostBody } from './schemas.js';
import { getPool } from '../db/client.js';
import { embedQuery } from '../embeddings/embedder.js';
import { loadThresholds } from '../decision/setup-meta.js';
import { logEvent } from '../decision/log-event.js';
import { EMBEDDER_VERSION } from '../embeddings/embedder.js';

interface SiblingRow {
  code: string;
  description_en: string | null;
  description_ar: string | null;
  parent10: string;
  vec_score: number; // 1 - cosine distance
}

export async function boostRoute(app: FastifyInstance): Promise<void> {
  app.post('/boost', async (req, reply) => {
    const t0 = Date.now();
    const parse = boostBody.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send({ error: 'invalid_body', detail: parse.error.flatten() });
    }
    const { code } = parse.data;
    const pool = getPool();

    const declaredRow = await pool.query<{
      code: string;
      description_en: string | null;
      description_ar: string | null;
      parent10: string;
    }>(
      `SELECT code, description_en, description_ar, parent10 FROM hs_codes WHERE code = $1`,
      [code]
    );

    if (declaredRow.rowCount === 0) {
      const totalLatency = Date.now() - t0;
      logEvent({
        endpoint: 'boost',
        request: { code },
        languageDetected: null,
        decisionStatus: 'needs_clarification',
        decisionReason: 'invalid_prefix',
        confidenceBand: null,
        chosenCode: null,
        alternatives: [],
        topRetrievalScore: 0,
        top2Gap: 0,
        candidateCount: 0,
        branchSize: 0,
        llmUsed: false,
        llmStatus: null,
        guardTripped: false,
        modelCalls: null,
        embedderVersion: EMBEDDER_VERSION(),
        llmModel: null,
        totalLatencyMs: totalLatency,
        error: null,
      }).catch((err) => app.log.error({ err }, 'logEvent failed'));
      return {
        decision_status: 'needs_clarification',
        decision_reason: 'invalid_prefix',
        alternatives: [],
        model: { embedder: EMBEDDER_VERSION(), llm: null },
      };
    }
    const declared = declaredRow.rows[0]!;

    // Build a synthetic query from the declared code's own description so we can score siblings semantically.
    const queryText =
      [declared.description_en, declared.description_ar].filter(Boolean).join(' | ') || code;
    const queryVec = await embedQuery(queryText);
    const queryVecStr = `[${queryVec.join(',')}]`;

    // Pull declared score + siblings under the same parent10
    const siblings = (
      await pool.query<SiblingRow>(
        `
        SELECT code, description_en, description_ar, parent10,
               1 - (embedding <=> $1::vector) AS vec_score
        FROM hs_codes
        WHERE parent10 = $2 AND is_leaf = true AND code != $3
        ORDER BY embedding <=> $1::vector
        LIMIT 20
      `,
        [queryVecStr, declared.parent10, code]
      )
    ).rows;

    const declaredScoreRow = (
      await pool.query<{ vec_score: number }>(
        `SELECT 1 - (embedding <=> $1::vector) AS vec_score FROM hs_codes WHERE code = $2`,
        [queryVecStr, code]
      )
    ).rows[0];
    const declaredScore = declaredScoreRow?.vec_score ?? 0;

    const t = await loadThresholds();
    const branchSize = siblings.length + 1;

    // If there are no siblings, declared is the only leaf in the parent10 → most specific.
    if (siblings.length === 0) {
      const totalLatency = Date.now() - t0;
      logEvent({
        endpoint: 'boost',
        request: { code },
        languageDetected: null,
        decisionStatus: 'accepted',
        decisionReason: 'already_most_specific',
        confidenceBand: 'high',
        chosenCode: code,
        alternatives: [],
        topRetrievalScore: declaredScore,
        top2Gap: 0,
        candidateCount: 0,
        branchSize,
        llmUsed: false,
        llmStatus: null,
        guardTripped: false,
        modelCalls: null,
        embedderVersion: EMBEDDER_VERSION(),
        llmModel: null,
        totalLatencyMs: totalLatency,
        error: null,
      }).catch((err) => app.log.error({ err }, 'logEvent failed'));
      return {
        decision_status: 'accepted',
        decision_reason: 'already_most_specific',
        confidence_band: 'high',
        before: {
          code,
          description_en: declared.description_en,
          description_ar: declared.description_ar,
        },
        after: {
          code,
          description_en: declared.description_en,
          description_ar: declared.description_ar,
        },
        alternatives: [],
        model: { embedder: EMBEDDER_VERSION(), llm: null },
      };
    }

    const topSibling = siblings[0]!;
    const margin = topSibling.vec_score - declaredScore;

    if (margin < t.BOOST_MARGIN) {
      const totalLatency = Date.now() - t0;
      logEvent({
        endpoint: 'boost',
        request: { code },
        languageDetected: null,
        decisionStatus: 'accepted',
        decisionReason: 'already_most_specific',
        confidenceBand: 'high',
        chosenCode: code,
        alternatives: siblings.slice(0, 3).map((s) => ({
          code: s.code,
          description_en: s.description_en,
          description_ar: s.description_ar,
          retrieval_score: Number(s.vec_score.toFixed(4)),
        })),
        topRetrievalScore: declaredScore,
        top2Gap: margin,
        candidateCount: siblings.length,
        branchSize,
        llmUsed: false,
        llmStatus: null,
        guardTripped: false,
        modelCalls: null,
        embedderVersion: EMBEDDER_VERSION(),
        llmModel: null,
        totalLatencyMs: totalLatency,
        error: null,
      }).catch((err) => app.log.error({ err }, 'logEvent failed'));
      return {
        decision_status: 'accepted',
        decision_reason: 'already_most_specific',
        confidence_band: 'high',
        before: {
          code,
          description_en: declared.description_en,
          description_ar: declared.description_ar,
        },
        after: {
          code,
          description_en: declared.description_en,
          description_ar: declared.description_ar,
        },
        alternatives: siblings.slice(0, 3).map((s) => ({
          code: s.code,
          description_en: s.description_en,
          description_ar: s.description_ar,
          retrieval_score: Number(s.vec_score.toFixed(4)),
        })),
        model: { embedder: EMBEDDER_VERSION(), llm: null },
      };
    }

    // A sibling beats the declared code by BOOST_MARGIN → propose it as the new most specific.
    const totalLatency = Date.now() - t0;
    const alts = siblings.slice(0, 5).map((s) => ({
      code: s.code,
      description_en: s.description_en,
      description_ar: s.description_ar,
      retrieval_score: Number(s.vec_score.toFixed(4)),
    }));

    logEvent({
      endpoint: 'boost',
      request: { code },
      languageDetected: null,
      decisionStatus: 'accepted',
      decisionReason: 'strong_match',
      confidenceBand: null,
      chosenCode: topSibling.code,
      alternatives: alts,
      topRetrievalScore: topSibling.vec_score,
      top2Gap: margin,
      candidateCount: siblings.length,
      branchSize,
      llmUsed: false,
      llmStatus: null,
      guardTripped: false,
      modelCalls: null,
      embedderVersion: EMBEDDER_VERSION(),
      llmModel: null,
      totalLatencyMs: totalLatency,
      error: null,
    }).catch((err) => app.log.error({ err }, 'logEvent failed'));

    return {
      decision_status: 'accepted',
      decision_reason: 'strong_match',
      before: {
        code,
        description_en: declared.description_en,
        description_ar: declared.description_ar,
      },
      after: {
        code: topSibling.code,
        description_en: topSibling.description_en,
        description_ar: topSibling.description_ar,
        retrieval_score: Number(topSibling.vec_score.toFixed(4)),
      },
      alternatives: alts,
      model: { embedder: EMBEDDER_VERSION(), llm: null },
    };
  });
}
