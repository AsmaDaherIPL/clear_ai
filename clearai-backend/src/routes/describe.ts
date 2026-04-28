/**
 * /classify/describe — free-text description → 12-digit HS code.
 *
 * v2 stateless control flow (ADR-0011). Worst-case: 3 LLM calls; common path: 1.
 *
 *   Stage 1   retrieve top-K candidates from the original input
 *   Stage 2   checkUnderstanding (chapter agreement among top-N)
 *               ├─ understood        → straight to gate + picker
 *               └─ not understood    → researcher → re-retrieve on canonical
 *   Stage 3   evidence gate
 *   Stage 4   picker (called once, no rescue loop)
 *   Stage 5   if no accepted code AND BEST_EFFORT_ENABLED:
 *               → best-effort fallback (returns 4-digit heading,
 *                 confidence_band='low', decision_status='best_effort')
 *
 * Stateless: no per-product caches, no profile memory. Every request is
 * handled from raw input. The interpretation block on the response surfaces
 * what the system actually classified, so the user can spot misinterpretations.
 */
import type { FastifyInstance } from 'fastify';
import { describeBody } from './schemas.js';
import { digitNormalize } from '../retrieval/digit-normalize.js';
import { loadKnownPrefixes } from '../retrieval/known-prefixes.js';
import { retrieveCandidates, type Candidate } from '../retrieval/retrieve.js';
import { loadThresholds } from '../decision/setup-meta.js';
import { evaluateGate } from '../decision/evidence-gate.js';
import { llmPick } from '../decision/llm-pick.js';
import { resolve } from '../decision/resolve.js';
import { logEvent } from '../decision/log-event.js';
import { detectLang } from '../util/lang.js';
import { EMBEDDER_VERSION } from '../embeddings/embedder.js';
import { env } from '../config/env.js';
import { checkUnderstanding } from '../preprocess/check-understanding.js';
import { researchInput, type ResearchOutcome } from '../preprocess/research.js';
import { bestEffortHeading, type BestEffortOutcome } from '../decision/best-effort-fallback.js';

type InterpretationStage = 'passthrough' | 'researched' | 'unknown';

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
    const t = await loadThresholds();

    // ---- Stage 1: retrieve top-K on the original input -------------------
    const norm1 = digitNormalize(description, known);
    let candidates: Candidate[] = await retrieveCandidates(norm1.cleanedText, {
      leavesOnly: true,
      ...(norm1.prefixBias ? { prefixBias: norm1.prefixBias } : {}),
      topK: t.RETRIEVAL_TOP_K_describe,
    });

    // ---- Stage 2: did retrieval understand? ------------------------------
    const understanding = checkUnderstanding(candidates, {
      maxDistinctChapters: t.UNDERSTOOD_MAX_DISTINCT_CHAPTERS,
      topK: t.UNDERSTOOD_TOP_K_describe,
    });

    let stage: InterpretationStage = 'passthrough';
    let effectiveDescription = description;
    let research: ResearchOutcome | null = null;

    if (!understanding.understood) {
      // ---- Stage 2b: researcher --------------------------------------------
      research = await researchInput(description);

      if (research.kind === 'recognised') {
        stage = 'researched';
        effectiveDescription = research.canonical;
        const norm2 = digitNormalize(effectiveDescription, known);
        candidates = await retrieveCandidates(norm2.cleanedText, {
          leavesOnly: true,
          ...(norm2.prefixBias ? { prefixBias: norm2.prefixBias } : {}),
          topK: t.RETRIEVAL_TOP_K_describe,
        });
      } else if (research.kind === 'unknown') {
        stage = 'unknown';
        // Researcher saw the input and explicitly declined to identify. We
        // do not run the picker on candidates we already know are wrong.
        // Whether we attempt best-effort here depends on the feature flag —
        // see the unified post-picker tail below.
      }
      // research.kind === 'failed' → stage stays 'passthrough'; the gate
      // will likely refuse on the original retrieval, which is the correct
      // degraded mode.
    }

    // ---- Stage 3 + 4: gate + picker (called at most once) ---------------
    const gate = evaluateGate(candidates, {
      minScore: t.MIN_SCORE_describe,
      minGap: t.MIN_GAP_describe,
    });

    let llm = null;
    // Skip the picker entirely if the researcher flagged the input as unknown:
    // we already know retrieval doesn't have the right product.
    const skipPicker = stage === 'unknown';
    if (!skipPicker && gate.passed && candidates.length > 0) {
      llm = await llmPick({
        kind: 'describe',
        query: effectiveDescription,
        candidates: candidates.slice(0, t.PICKER_CANDIDATES_describe),
        model: env().LLM_MODEL_STRONG,
      });
    }

    const decision = resolve({ gate, llm });

    // ---- Stage 5: best-effort fallback tail ------------------------------
    // Trigger when the route has not produced an accepted code AND the
    // feature flag is on. Stateless, never stores anything. Returns a
    // low-confidence heading capped at BEST_EFFORT_MAX_DIGITS digits.
    let bestEffort: BestEffortOutcome | null = null;
    const needsFallback =
      t.BEST_EFFORT_ENABLED === 1 && decision.decisionStatus !== 'accepted';

    if (needsFallback) {
      bestEffort = await bestEffortHeading({
        rawInput: description,
        maxDigits: t.BEST_EFFORT_MAX_DIGITS,
        maxTokens: t.BEST_EFFORT_MAX_TOKENS,
        model: env().LLM_MODEL_STRONG,
      });
    }

    // If the fallback succeeded, swap the decision to a 'best_effort' envelope.
    // We deliberately do not overwrite `decision` for accepted/degraded paths
    // — those still own the response shape. The intermediate `accepted`
    // variable narrows the discriminated union for downstream use.
    const accepted: Extract<BestEffortOutcome, { kind: 'ok' }> | null =
      bestEffort && bestEffort.kind === 'ok' ? bestEffort : null;

    const alternatives = candidates
      .slice(0, t.ALTERNATIVES_SHOWN_describe)
      .map((c) => ({
        code: c.code,
        description_en: c.description_en,
        description_ar: c.description_ar,
        retrieval_score: Number(c.rrf_score.toFixed(4)),
      }));

    const totalLatency = Date.now() - t0;

    // Log the event with the *final* decision status — best_effort if the
    // fallback produced a heading, otherwise whatever resolve() returned.
    const loggedStatus = accepted ? 'best_effort' : decision.decisionStatus;
    const loggedReason = accepted ? 'best_effort_heading' : decision.decisionReason;
    const loggedConfidence: 'high' | 'medium' | 'low' | null = accepted
      ? 'low'
      : (decision.confidenceBand ?? null);
    const loggedChosen = accepted ? accepted.code : decision.chosenCode;

    logEvent({
      endpoint: 'describe',
      request: {
        description,
        digit_normalisation: norm1.detected,
        prefix_bias: norm1.prefixBias,
        understanding_distinct_chapters: understanding.distinctChapters,
        understanding_chapters: understanding.chapters,
        interpretation_stage: stage,
        rewritten_as: stage === 'researched' ? effectiveDescription : null,
        research_kind: research?.kind ?? null,
        research_latency_ms: research?.latencyMs ?? null,
        best_effort_invoked: needsFallback,
        best_effort_specificity: accepted ? accepted.specificity : null,
      },
      languageDetected: lang,
      decisionStatus: loggedStatus,
      decisionReason: loggedReason,
      confidenceBand: loggedConfidence,
      chosenCode: loggedChosen,
      alternatives,
      topRetrievalScore: gate.topRetrievalScore,
      top2Gap: gate.top2Gap,
      candidateCount: candidates.length,
      branchSize: null,
      llmUsed: !!llm || !!accepted,
      llmStatus: llm?.llmStatus ?? null,
      guardTripped: llm?.guardTripped ?? false,
      modelCalls: [
        ...(research && research.kind !== 'failed'
          ? [{ model: research.model, latency_ms: research.latencyMs, status: 'ok' as const }]
          : []),
        ...(llm
          ? [{ model: llm.llmModel, latency_ms: llm.latencyMs, status: llm.llmStatus }]
          : []),
        ...(accepted
          ? [
              {
                model: accepted.model,
                latency_ms: accepted.latencyMs,
                status: 'ok' as const,
              },
            ]
          : []),
      ],
      embedderVersion: EMBEDDER_VERSION(),
      llmModel: accepted ? accepted.model : (llm?.llmModel ?? null),
      totalLatencyMs: totalLatency,
      error: null,
    }).catch((err) => app.log.error({ err }, 'logEvent failed'));

    // ---- Response shape --------------------------------------------------

    // Best-effort response (verify-toggle gated on the frontend).
    if (accepted) {
      return {
        decision_status: 'best_effort' as const,
        decision_reason: 'best_effort_heading' as const,
        confidence_band: 'low' as const,
        result: {
          code: accepted.code,
          // Best-effort returns a chapter-level prefix, not a leaf row from
          // hs_codes — we don't try to look up EN/AR descriptions for it. The
          // frontend renders the rationale instead.
          description_en: null,
          description_ar: null,
        },
        rationale: accepted.rationale,
        alternatives,
        interpretation: {
          original: description,
          stage,
          ...(stage === 'researched' && { rewritten_as: effectiveDescription }),
          ...(stage === 'unknown' && research && research.kind === 'unknown'
            ? { researcher_note: research.reason }
            : {}),
        },
        model: {
          embedder: EMBEDDER_VERSION(),
          llm: llm?.llmModel ?? null,
          best_effort: accepted.model,
          ...(research && research.kind === 'recognised' ? { researcher: research.model } : {}),
        },
      };
    }

    // Researcher-declined response (no fallback — feature flag off).
    if (stage === 'unknown' && research && research.kind === 'unknown') {
      return {
        decision_status: 'needs_clarification' as const,
        decision_reason: 'brand_not_recognised' as const,
        alternatives: [],
        interpretation: {
          original: description,
          stage,
          researcher_note: research.reason,
        },
        model: {
          embedder: EMBEDDER_VERSION(),
          llm: null,
          researcher: research.model,
        },
      };
    }

    // Standard envelope (accepted / needs_clarification / degraded).
    return {
      decision_status: decision.decisionStatus,
      decision_reason: decision.decisionReason,
      ...(decision.confidenceBand && { confidence_band: decision.confidenceBand }),
      ...(decision.chosenCode && {
        result: {
          code: decision.chosenCode,
          description_en:
            candidates.find((c) => c.code === decision.chosenCode)?.description_en ?? null,
          description_ar:
            candidates.find((c) => c.code === decision.chosenCode)?.description_ar ?? null,
          retrieval_score: Number(
            (candidates.find((c) => c.code === decision.chosenCode)?.rrf_score ?? 0).toFixed(4),
          ),
        },
      }),
      alternatives,
      ...(decision.rationale && { rationale: decision.rationale }),
      ...(decision.missingAttributes.length > 0 && {
        missing_attributes: decision.missingAttributes,
      }),
      interpretation: {
        original: description,
        stage,
        ...(stage === 'researched' && { rewritten_as: effectiveDescription }),
      },
      model: {
        embedder: EMBEDDER_VERSION(),
        llm: llm?.llmModel ?? null,
        ...(research && research.kind === 'recognised' ? { researcher: research.model } : {}),
      },
    };
  });
}
