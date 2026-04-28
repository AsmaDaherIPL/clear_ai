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
import { filterAlternatives } from '../decision/filter-alternatives.js';
import { enumerateBranch, type BranchLeaf } from '../decision/branch-enumerate.js';
import { cleanMerchantInput, type MerchantCleanupResult } from '../preprocess/merchant-cleanup.js';

type InterpretationStage = 'passthrough' | 'cleaned' | 'researched' | 'unknown';

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

    let stage: InterpretationStage = 'passthrough';
    let effectiveDescription = description;
    let research: ResearchOutcome | null = null;
    let cleanup: MerchantCleanupResult | null = null;

    // ---- Stage 0: merchant-input cleanup (Phase 1.5, ADR-0012) -----------
    // Strips brand/SKU/marketing noise from raw merchant strings BEFORE
    // retrieval. Deterministically skipped on inputs that already look
    // clean (≤4 tokens, no SKU pattern, no marketing punctuation) — saves
    // an LLM call on the ~80% of merchant descriptions that are already
    // 1–3 word stubs. On noisy inputs, fires Haiku to extract a clean
    // product noun and customs-relevant attributes.
    if (t.MERCHANT_CLEANUP_ENABLED === 1) {
      cleanup = await cleanMerchantInput(description, {
        maxTokens: t.MERCHANT_CLEANUP_MAX_TOKENS,
      });
      if (cleanup.invoked === 'llm' && cleanup.kind === 'product') {
        // The cleanup gave us a recognisable product type. Use that as the
        // retrieval input. Attributes (Bluetooth, over-ear, ANC, …) are
        // appended as a hint string so retrieval picks up signal from them
        // without anchoring on brand/SKU noise.
        const attrPart = cleanup.attributes.length > 0 ? ` ${cleanup.attributes.join(' ')}` : '';
        effectiveDescription = `${cleanup.effective}${attrPart}`.trim();
        stage = 'cleaned';
      }
      // For kind === 'merchant_shorthand' or 'ungrounded' we leave
      // effectiveDescription as the raw input. Stage 2 below will route
      // shorthand to the researcher; ungrounded falls through to the gate
      // which will refuse it. No need to short-circuit here — the
      // existing control flow handles both.
    }

    // ---- Stage 1: retrieve top-K on the (possibly cleaned) input ---------
    const norm1 = digitNormalize(effectiveDescription, known);
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

    if (!understanding.understood) {
      // ---- Stage 2b: researcher --------------------------------------------
      // Always research on the original input — the researcher is what
      // resolves merchant shorthand like "Arizona BFBC Mocca43" by world
      // knowledge, and feeding it the cleaned (likely empty) text would
      // strip the very signal it needs.
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
      // research.kind === 'failed' → stage stays 'cleaned'/'passthrough';
      // the gate will likely refuse on the retrieval, which is the correct
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

    // Alternatives surface — sourced differently per decision status.
    //
    //   accepted     → branch-local enumeration. Deterministic SQL pull of
    //                  every leaf under the chosen code's HS-6 prefix.
    //                  Same chosen code, same alternatives, every time.
    //   not accepted → filtered RRF top-K (Phase 0). The picker didn't
    //                  commit to a branch, so we have nothing to enumerate
    //                  under — fall back to the cleaned retrieval list.
    //
    // Phase 1 of the v3 alternatives redesign (ADR-0012). See
    // src/decision/branch-enumerate.ts for the full rationale.
    const chosenForAlts = accepted ? accepted.code : decision.chosenCode;
    const isAcceptedFamily =
      decision.decisionStatus === 'accepted' &&
      decision.chosenCode !== null &&
      /^\d{12}$/.test(decision.chosenCode);

    type Alt = {
      code: string;
      description_en: string | null;
      description_ar: string | null;
      retrieval_score: number | null;
    };
    let alternatives: Alt[];
    let branchLeaves: BranchLeaf[] | null = null;

    if (isAcceptedFamily && decision.chosenCode) {
      branchLeaves = await enumerateBranch({
        chosenCode: decision.chosenCode,
        prefixLength: t.BRANCH_PREFIX_LENGTH as 4 | 6 | 8,
        maxLeaves: t.BRANCH_MAX_LEAVES,
      });
      // Pin chosen first, then siblings in catalog order. Score is null on
      // branch-sourced rows because RRF doesn't apply here — the surface
      // is enumeration, not retrieval.
      const chosen = branchLeaves.find((l) => l.code === decision.chosenCode);
      const others = branchLeaves.filter((l) => l.code !== decision.chosenCode);
      const ordered = chosen ? [chosen, ...others] : branchLeaves;
      alternatives = ordered.slice(0, t.ALTERNATIVES_SHOWN_describe).map((l) => ({
        code: l.code,
        description_en: l.description_en,
        description_ar: l.description_ar,
        retrieval_score: null,
      }));
    } else {
      alternatives = filterAlternatives(candidates, {
        chosenCode: chosenForAlts,
        minScore: t.MIN_ALT_SCORE,
        strongRatio: t.STRONG_ALT_RATIO,
        maxShown: t.ALTERNATIVES_SHOWN_describe,
      }).map((c) => ({
        code: c.code,
        description_en: c.description_en,
        description_ar: c.description_ar,
        retrieval_score: Number(c.rrf_score.toFixed(4)),
      }));
    }

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
        // Phase 1.5 — cleanup observability. invoked is one of
        // 'skipped_clean' | 'llm' | 'llm_failed' | 'llm_unparseable' so we
        // can A/B the cleanup phase against accuracy/latency without
        // re-running the whole pipeline.
        cleanup_invoked: cleanup?.invoked ?? null,
        cleanup_kind: cleanup?.invoked === 'llm' ? cleanup.kind : null,
        cleanup_effective: cleanup?.invoked === 'llm' ? cleanup.effective : null,
        cleanup_attributes_count: cleanup?.attributes.length ?? 0,
        cleanup_stripped_count: cleanup?.stripped.length ?? 0,
        cleanup_latency_ms: cleanup?.latencyMs ?? 0,
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
        ...(cleanup && cleanup.invoked === 'llm' && cleanup.model
          ? [
              {
                model: cleanup.model,
                latency_ms: cleanup.latencyMs,
                status: 'ok' as const,
              },
            ]
          : []),
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
        interpretation: buildInterpretation({ description, stage, effectiveDescription, research, cleanup }),
        model: {
          embedder: EMBEDDER_VERSION(),
          llm: llm?.llmModel ?? null,
          best_effort: accepted.model,
          ...(research && research.kind === 'recognised' ? { researcher: research.model } : {}),
          ...(cleanup && cleanup.invoked === 'llm' && cleanup.model
            ? { cleanup: cleanup.model }
            : {}),
        },
      };
    }

    // Researcher-declined response (no fallback — feature flag off).
    if (stage === 'unknown' && research && research.kind === 'unknown') {
      return {
        decision_status: 'needs_clarification' as const,
        decision_reason: 'brand_not_recognised' as const,
        alternatives: [],
        interpretation: buildInterpretation({ description, stage, effectiveDescription, research, cleanup }),
        model: {
          embedder: EMBEDDER_VERSION(),
          llm: null,
          researcher: research.model,
          ...(cleanup && cleanup.invoked === 'llm' && cleanup.model
            ? { cleanup: cleanup.model }
            : {}),
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
      interpretation: buildInterpretation({ description, stage, effectiveDescription, research, cleanup }),
      model: {
        embedder: EMBEDDER_VERSION(),
        llm: llm?.llmModel ?? null,
        ...(research && research.kind === 'recognised' ? { researcher: research.model } : {}),
        ...(cleanup && cleanup.invoked === 'llm' && cleanup.model
          ? { cleanup: cleanup.model }
          : {}),
      },
    };
  });
}

/**
 * Centralise the interpretation block so all three response shapes
 * (best-effort, researcher-declined, standard envelope) emit it identically.
 * The block surfaces every transformation we did to the user's input —
 * `cleaned_as` if cleanup ran and produced a different effective string,
 * `rewritten_as` if the researcher rewrote it, plus a researcher note when
 * the input couldn't be identified. Frontend uses this to render an
 * "Understood as: …" line so the user can spot misinterpretation.
 */
function buildInterpretation(params: {
  description: string;
  stage: InterpretationStage;
  effectiveDescription: string;
  research: ResearchOutcome | null;
  cleanup: MerchantCleanupResult | null;
}): {
  original: string;
  stage: InterpretationStage;
  cleaned_as?: string;
  cleanup_kind?: 'product' | 'merchant_shorthand' | 'ungrounded';
  cleanup_attributes?: string[];
  cleanup_stripped?: string[];
  rewritten_as?: string;
  researcher_note?: string;
} {
  const { description, stage, effectiveDescription, research, cleanup } = params;
  const out: ReturnType<typeof buildInterpretation> = {
    original: description,
    stage,
  };

  // Surface cleanup outcome whenever the LLM ran (regardless of whether the
  // result was used as the retrieval input). The frontend can show "we
  // ignored: Samsung, Galaxy S25 Ultra, …" so the user can sanity-check.
  if (cleanup && cleanup.invoked === 'llm') {
    if (cleanup.kind === 'product' && cleanup.effective !== description) {
      out.cleaned_as = cleanup.effective;
    }
    out.cleanup_kind = cleanup.kind;
    if (cleanup.attributes.length > 0) out.cleanup_attributes = cleanup.attributes;
    if (cleanup.stripped.length > 0) out.cleanup_stripped = cleanup.stripped;
  }

  if (stage === 'researched') out.rewritten_as = effectiveDescription;
  if (stage === 'unknown' && research && research.kind === 'unknown') {
    out.researcher_note = research.reason;
  }
  return out;
}
