import type { FastifyInstance } from 'fastify';
import { describeBody } from './schemas.js';
import { digitNormalize } from '../retrieval/digit-normalize.js';
import { loadKnownPrefixes } from '../retrieval/known-prefixes.js';
import { retrieveCandidates } from '../retrieval/retrieve.js';
import { loadThresholds } from '../decision/setup-meta.js';
import { evaluateGate } from '../decision/evidence-gate.js';
import { llmPick } from '../decision/llm-pick.js';
import { resolve } from '../decision/resolve.js';
import { logEvent } from '../decision/log-event.js';
import { detectLang } from '../util/lang.js';
import { EMBEDDER_VERSION } from '../embeddings/embedder.js';
import { env } from '../config/env.js';

export async function describeRoute(app: FastifyInstance): Promise<void> {
  app.post('/classify/describe', async (req, reply) => {
    const t0 = Date.now();
    const parse = describeBody.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send({ error: 'invalid_body', detail: parse.error.flatten() });
    }
    const { description } = parse.data;
    const lang = detectLang(description);

    const known = await loadKnownPrefixes();
    const norm = digitNormalize(description, known);

    const candidates = await retrieveCandidates(norm.cleanedText, {
      leavesOnly: true,
      ...(norm.prefixBias ? { prefixBias: norm.prefixBias } : {}),
      topK: 12,
    });

    const t = await loadThresholds();
    const gate = evaluateGate(candidates, {
      minScore: t.MIN_SCORE_describe,
      minGap: t.MIN_GAP_describe,
    });

    let llm = null;
    if (gate.passed && candidates.length > 0) {
      llm = await llmPick({
        kind: 'describe',
        query: description,
        candidates: candidates.slice(0, 8),
        model: env().LLM_MODEL_STRONG, // Sonnet for /describe (broad picking)
      });
    }

    const decision = resolve({ gate, llm });

    const alternatives = candidates.slice(0, 5).map((c) => ({
      code: c.code,
      description_en: c.description_en,
      description_ar: c.description_ar,
      retrieval_score: Number(c.rrf_score.toFixed(4)),
    }));

    const totalLatency = Date.now() - t0;

    // Async log; do not block response on it.
    logEvent({
      endpoint: 'describe',
      request: { description, digit_normalisation: norm.detected, prefix_bias: norm.prefixBias },
      languageDetected: lang,
      decisionStatus: decision.decisionStatus,
      decisionReason: decision.decisionReason,
      confidenceBand: decision.confidenceBand ?? null,
      chosenCode: decision.chosenCode,
      alternatives,
      topRetrievalScore: gate.topRetrievalScore,
      top2Gap: gate.top2Gap,
      candidateCount: candidates.length,
      branchSize: null,
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
        result: {
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
