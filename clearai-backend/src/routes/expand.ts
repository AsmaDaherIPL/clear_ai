import type { FastifyInstance } from 'fastify';
import { expandBody } from './schemas.js';
import { retrieveCandidates } from '../retrieval/retrieve.js';
import { loadThresholds } from '../decision/setup-meta.js';
import { evaluateGate } from '../decision/evidence-gate.js';
import { llmPick } from '../decision/llm-pick.js';
import { resolve } from '../decision/resolve.js';
import { logEvent } from '../decision/log-event.js';
import { detectLang } from '../util/lang.js';
import { EMBEDDER_VERSION } from '../embeddings/embedder.js';
import { env } from '../config/env.js';
import { getPool } from '../db/client.js';

export async function expandRoute(app: FastifyInstance): Promise<void> {
  app.post('/classify/expand', async (req, reply) => {
    const t0 = Date.now();
    const parse = expandBody.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send({ error: 'invalid_body', detail: parse.error.flatten() });
    }
    const { code: parentPrefix, description } = parse.data;
    const lang = detectLang(description);

    // Branch-size sanity for logging + invalid_prefix detection
    const pool = getPool();
    const branchCountRes = await pool.query<{ count: string }>(
      `SELECT count(*)::text FROM hs_codes WHERE is_leaf = true AND code LIKE $1`,
      [`${parentPrefix}%`]
    );
    const branchSize = Number(branchCountRes.rows[0]?.count ?? 0);

    if (branchSize === 0) {
      const totalLatency = Date.now() - t0;
      logEvent({
        endpoint: 'expand',
        request: { code: parentPrefix, description },
        languageDetected: lang,
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

    const candidates = await retrieveCandidates(description, {
      leavesOnly: true,
      prefixFilter: parentPrefix,
      topK: 12,
    });

    const t = await loadThresholds();
    const gate = evaluateGate(candidates, {
      minScore: t.MIN_SCORE_expand,
      minGap: t.MIN_GAP_expand,
    });

    // Single-descendant special case: if only one leaf exists, accept it without LLM
    const singleValidDescendant = branchSize === 1;
    let llm = null;
    if (gate.passed && !singleValidDescendant && candidates.length > 0) {
      llm = await llmPick({
        kind: 'expand',
        query: description,
        candidates: candidates.slice(0, 8),
        parentPrefix,
        model: env().LLM_MODEL, // Haiku for narrow within-branch picking
      });
    }

    let chosenCode: string | null = null;
    if (singleValidDescendant && gate.passed) {
      chosenCode = candidates[0]?.code ?? null;
    }

    const decision = resolve({
      gate,
      llm,
      ...(singleValidDescendant && chosenCode ? { singleValidDescendant: true } : {}),
    });

    // For single-descendant we override LLM-less acceptance
    if (singleValidDescendant && chosenCode && gate.passed) {
      decision.chosenCode = chosenCode;
      decision.decisionStatus = 'accepted';
      decision.decisionReason = 'single_valid_descendant';
    }

    const alternatives = candidates.slice(0, 5).map((c) => ({
      code: c.code,
      description_en: c.description_en,
      description_ar: c.description_ar,
      retrieval_score: Number(c.rrf_score.toFixed(4)),
    }));

    const totalLatency = Date.now() - t0;

    logEvent({
      endpoint: 'expand',
      request: { code: parentPrefix, description },
      languageDetected: lang,
      decisionStatus: decision.decisionStatus,
      decisionReason: decision.decisionReason,
      confidenceBand: decision.confidenceBand ?? null,
      chosenCode: decision.chosenCode,
      alternatives,
      topRetrievalScore: gate.topRetrievalScore,
      top2Gap: gate.top2Gap,
      candidateCount: candidates.length,
      branchSize,
      llmUsed: !!llm,
      llmStatus: llm?.llmStatus ?? null,
      guardTripped: llm?.guardTripped ?? false,
      modelCalls: llm
        ? [{ model: llm.llmModel, latency_ms: llm.latencyMs, status: llm.llmStatus }]
        : null,
      embedderVersion: EMBEDDER_VERSION(),
      llmModel: llm?.llmModel ?? null,
      totalLatencyMs: totalLatency,
      error: null,
    }).catch((err) => app.log.error({ err }, 'logEvent failed'));

    return {
      decision_status: decision.decisionStatus,
      decision_reason: decision.decisionReason,
      ...(decision.confidenceBand && { confidence_band: decision.confidenceBand }),
      ...(decision.chosenCode && {
        before: { code: parentPrefix },
        after: {
          code: decision.chosenCode,
          description_en: candidates.find((c) => c.code === decision.chosenCode)?.description_en ?? null,
          description_ar: candidates.find((c) => c.code === decision.chosenCode)?.description_ar ?? null,
          retrieval_score: Number(
            (candidates.find((c) => c.code === decision.chosenCode)?.rrf_score ?? 0).toFixed(4)
          ),
        },
      }),
      alternatives,
      ...(decision.rationale && { rationale: decision.rationale }),
      ...(decision.missingAttributes.length > 0 && { missing_attributes: decision.missingAttributes }),
      model: { embedder: EMBEDDER_VERSION(), llm: llm?.llmModel ?? null },
    };
  });
}
