/**
 * POST /classifications — free-text description → 12-digit HS code.
 * Persisted endpoint name stays 'describe' for trace continuity.
 */
import type { FastifyInstance } from 'fastify';
import { classifyBody } from './schemas.js';
import { digitNormalize } from '../retrieval/digit-normalize.js';
import { loadKnownPrefixes } from '../retrieval/known-prefixes.js';
import { retrieveCandidates, type Candidate } from '../retrieval/retrieve.js';
import { getPool } from '../db/client.js';
import { loadThresholds, isEnabled } from '../catalog/setup-meta.js';
import { evaluateGate } from '../classification/evidence-gate.js';
import { llmPick } from '../classification/llm-pick.js';
import { resolve } from '../classification/resolve.js';
import { logEvent } from '../observability/log-event.js';
import { detectLang } from '../util/lang.js';
import { EMBEDDER_VERSION } from '../embeddings/embedder.js';
import { env } from '../config/env.js';
import { checkUnderstanding } from '../preprocess/check-understanding.js';
import { researchInput, type ResearchOutcome } from '../preprocess/research.js';
import {
  researchInputWithWeb,
  type ResearchWithWebOutcome,
} from '../preprocess/research-with-web.js';
import { filterAlternatives } from '../classification/filter-alternatives.js';
import { enumerateBranch, type BranchLeaf } from '../classification/branch-enumerate.js';
import { parseDutyInfo } from '../catalog/duty-info.js';
import { lookupProcedures, type ProcedureInfo } from '../catalog/procedure-codes.js';
import { rankBranch, type BranchRankResult } from '../classification/branch-rank.js';
import type { MerchantCleanupResult } from '../preprocess/merchant-cleanup.js';
import { round4 } from '../util/score.js';
import { withRequestId, trimAlternativeDashes, trimCatalogDashes } from './_helpers.js';
import type { ModelCallTrace } from '../llm/structured-call.js';
import type { LlmStatus } from '../llm/client.js';
import { buildInterpretation, type InterpretationStage } from '../classification/interpretation.js';
import { runCleanupStage } from '../classification/stages/cleanup-stage.js';
import { runBestEffortStage } from '../classification/stages/best-effort-stage.js';

export async function classifyRoute(app: FastifyInstance): Promise<void> {
  app.post('/classifications', async (req, reply) => {
    const t0 = Date.now();
    const parse = classifyBody.safeParse(req.body);
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
    let researchWeb: ResearchWithWebOutcome | null = null;
    let cleanup: MerchantCleanupResult | null = null;

    /** Per-request trace of every LLM call that fired, in order. */
    const modelCalls: ModelCallTrace[] = [];
    const recordCall = (
      model: string | null | undefined,
      latency_ms: number,
      stageLabel: string,
      status: LlmStatus = 'ok',
    ): void => {
      if (!model) return;
      modelCalls.push({ model, latency_ms, stage: stageLabel, status });
    };

    // Stage 0 — merchant-input cleanup.
    const cleanupStage = await runCleanupStage({
      description,
      thresholds: t,
      modelCalls,
    });
    cleanup = cleanupStage.cleanup;
    effectiveDescription = cleanupStage.effectiveDescription;
    stage = cleanupStage.stage;

    // Stage 1 — retrieve top-K on the (possibly cleaned) input.
    const norm1 = digitNormalize(effectiveDescription, known);
    let candidates: Candidate[] = await retrieveCandidates(norm1.cleanedText, {
      leavesOnly: true,
      ...(norm1.prefixBias ? { prefixBias: norm1.prefixBias } : {}),
      topK: t.RETRIEVAL_TOP_K_describe,
    });

    // Stage 2 — did retrieval understand? Composite chapter-coherence + noun-alignment.
    const customsNoun =
      cleanup && cleanup.invoked === 'llm' && cleanup.kind === 'product'
        ? cleanup.effective
        : null;
    const cleanupIsShorthand =
      cleanup && cleanup.invoked === 'llm' && cleanup.kind === 'merchant_shorthand';
    const understanding = checkUnderstanding(candidates, {
      maxDistinctChapters: t.UNDERSTOOD_MAX_DISTINCT_CHAPTERS,
      topK: t.UNDERSTOOD_TOP_K_describe,
      ...(customsNoun ? { customsNoun } : {}),
    });
    if (cleanupIsShorthand && understanding.understood) {
      // Force shorthand inputs through the researcher even if coherence looks strong.
      understanding.understood = false;
      understanding.strength = 'weak';
      understanding.reason = 'noun_misaligned';
    }

    if (!understanding.understood) {
      // Stage 2b — researcher. Always runs on the original input.
      research = await researchInput(description);
      if (research.kind !== 'failed') {
        recordCall(research.model, research.latencyMs, 'research');
      }

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
        // Web-augmented researcher escalation — one hosted web_search per request.
        if (isEnabled(t, 'RESEARCH_WEB_ENABLED')) {
          researchWeb = await researchInputWithWeb(description, {
            maxTokens: t.RESEARCH_WEB_MAX_TOKENS,
          });
          if (researchWeb.kind !== 'failed') {
            recordCall(researchWeb.model, researchWeb.latencyMs, 'research_web');
          }
          if (researchWeb.kind === 'recognised') {
            stage = 'researched';
            effectiveDescription = researchWeb.canonical;
            const norm2 = digitNormalize(effectiveDescription, known);
            candidates = await retrieveCandidates(norm2.cleanedText, {
              leavesOnly: true,
              ...(norm2.prefixBias ? { prefixBias: norm2.prefixBias } : {}),
              topK: t.RETRIEVAL_TOP_K_describe,
            });
          } else {
            stage = 'unknown';
          }
        } else {
          stage = 'unknown';
        }
      }
    }

    // Stage 2c — heading-padded code injection. Bounded assist: only when
    // understanding is strong and the noun appears in the heading text.
    if (candidates.length > 0 && understanding.strength === 'strong') {
      const top = candidates[0]!;
      const headingPrefix = top.code.slice(0, 4);
      const candidateHeadingCode = `${headingPrefix}00000000`;
      const alreadyPresent = candidates.some((c) => c.code === candidateHeadingCode);
      if (!alreadyPresent) {
        const pool = getPool();
        const r = await pool.query<{
          code: string;
          description_en: string | null;
          description_ar: string | null;
        }>(
          `SELECT code, description_en, description_ar FROM hs_codes WHERE code = $1 AND is_leaf = true`,
          [candidateHeadingCode],
        );
        const row = r.rows[0];
        if (row) {
          const headingText = `${row.description_en ?? ''} ${row.description_ar ?? ''}`.toLowerCase();
          const nounAlignsWithHeading =
            !customsNoun || headingText.includes(customsNoun.toLowerCase());
          if (nounAlignsWithHeading) {
            candidates = [
              ...candidates,
              {
                code: row.code,
                description_en: row.description_en,
                description_ar: row.description_ar,
                parent10: row.code.slice(0, 10),
                vec_rank: null,
                bm25_rank: null,
                trgm_rank: null,
                vec_score: null,
                bm25_score: null,
                trgm_score: null,
                rrf_score: top.rrf_score, // tied with top so it competes
              },
            ];
          }
        }
      }
    }

    // Stage 3 + 4 — gate + picker (called at most once).
    const gate = evaluateGate(
      candidates,
      {
        minScore: t.MIN_SCORE_describe,
        minGap: t.MIN_GAP_describe,
      },
      effectiveDescription,
    );

    let llm = null;
    const skipPicker = stage === 'unknown';
    if (!skipPicker && candidates.length > 0 && gate.passed) {
      llm = await llmPick({
        kind: 'describe',
        query: effectiveDescription,
        candidates: candidates.slice(0, t.PICKER_CANDIDATES_describe),
        model: env().LLM_MODEL_STRONG,
      });
      recordCall(llm.llmModel, llm.latencyMs, 'picker', llm.llmStatus);
    }

    const decision = resolve({ gate, llm });

    // Stage 5 — best-effort fallback + heading-level promotion.
    const bestEffortStage = await runBestEffortStage({
      description,
      thresholds: t,
      decision,
      candidates,
      modelCalls,
    });
    const bestEffort = bestEffortStage.bestEffort;
    let accepted = bestEffortStage.accepted;
    const noSignalBestEffort = bestEffortStage.noSignalBestEffort;
    const headingLevelPromoted = bestEffortStage.headingLevelPromoted;
    if (bestEffortStage.decisionPatch.decisionStatus) {
      decision.decisionStatus = bestEffortStage.decisionPatch.decisionStatus;
    }
    if (bestEffortStage.decisionPatch.decisionReason) {
      decision.decisionReason = bestEffortStage.decisionPatch.decisionReason;
    }
    if (bestEffortStage.decisionPatch.confidenceBand) {
      decision.confidenceBand = bestEffortStage.decisionPatch.confidenceBand;
    }
    if (bestEffortStage.decisionPatch.chosenCode) {
      decision.chosenCode = bestEffortStage.decisionPatch.chosenCode;
    }
    if (bestEffortStage.decisionPatch.rationale) {
      decision.rationale = bestEffortStage.decisionPatch.rationale;
    }

    // Alternatives — branch enumeration when accepted, filtered RRF otherwise.
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
      /** Source bucket for per-row UI badge. */
      source?: 'branch_8' | 'branch_6' | 'branch_4' | 'rrf';
      rank?: number;
      fit?: 'fits' | 'partial' | 'excludes';
      reason?: string;
    };
    let alternatives: Alt[];
    let branchLeaves: BranchLeaf[] | null = null;
    let branchRank: BranchRankResult | null = null;
    /** Final code shipped to the user; may be branch-rank's override. */
    let effectiveChosenCode: string | null = decision.chosenCode;

    if (isAcceptedFamily && decision.chosenCode) {
      branchLeaves = await enumerateBranch({
        chosenCode: decision.chosenCode,
        prefixLength: t.BRANCH_PREFIX_LENGTH as 4 | 6 | 8,
        minSiblings: t.ALTERNATIVES_MIN_SHOWN,
        maxLeaves: t.BRANCH_MAX_LEAVES,
      });

      // Confident-pick fast path: skip branch-rank when retrieval is decisive.
      const branchRankConfidentSkip = gate.top2Gap > t.MIN_GAP_describe * 3;
      const branchRankShouldRun =
        isEnabled(t, 'BRANCH_RANK_ENABLED') && !branchRankConfidentSkip;

      branchRank = await rankBranch({
        query: effectiveDescription,
        chosenCode: decision.chosenCode,
        leaves: branchLeaves,
        opts: {
          enabled: branchRankShouldRun,
          maxTokens: t.BRANCH_RANK_MAX_TOKENS,
        },
      });

      if (branchRank.invoked === 'llm') {
        recordCall(branchRank.model, branchRank.latencyMs, 'branch_rank');
      }

      if (branchRank.invoked === 'llm' && !branchRank.agreesWithPicker) {
        effectiveChosenCode = branchRank.effectiveCode;
      }

      const sourceByCode = new Map(branchLeaves.map((l) => [l.code, l.source]));

      // Chosen code is excluded — it ships at top-level on `result.code`.
      if (branchRank.invoked === 'llm') {
        alternatives = branchRank.ranking
          .filter((r) => r.code !== effectiveChosenCode)
          .slice(0, t.ALTERNATIVES_SHOWN_describe)
          .map((r) => ({
            code: r.code,
            description_en: r.description_en,
            description_ar: r.description_ar,
            retrieval_score: null,
            source: sourceByCode.get(r.code) ?? 'branch_8',
            rank: r.rank,
            fit: r.fit,
            reason: r.reason,
          }));
      } else {
        alternatives = branchLeaves
          .filter((l) => l.code !== effectiveChosenCode)
          .slice(0, t.ALTERNATIVES_SHOWN_describe)
          .map((l) => ({
            code: l.code,
            description_en: l.description_en,
            description_ar: l.description_ar,
            retrieval_score: null,
            source: l.source,
          }));
      }

      // RRF top-up when branch enumeration produced fewer than the minimum.
      if (alternatives.length < t.ALTERNATIVES_MIN_SHOWN) {
        const have = new Set(alternatives.map((a) => a.code));
        const filtered = filterAlternatives(candidates, {
          chosenCode: effectiveChosenCode,
          minScore: t.MIN_ALT_SCORE,
          strongRatio: t.STRONG_ALT_RATIO,
          maxShown: t.ALTERNATIVES_SHOWN_describe,
        });
        for (const c of filtered) {
          if (have.has(c.code)) continue;
          alternatives.push({
            code: c.code,
            description_en: c.description_en,
            description_ar: c.description_ar,
            retrieval_score: round4(c.rrf_score),
            source: 'rrf',
          });
          if (alternatives.length >= t.ALTERNATIVES_SHOWN_describe) break;
        }
      }
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
        retrieval_score: round4(c.rrf_score),
        source: 'rrf' as const,
      }));
    }

    // Strip catalog tree-depth dashes in place — same array flows to logEvent and response.
    trimAlternativeDashes(alternatives);

    // Duty + procedures lookup against the chosen leaf.
    let dutyInfo: ReturnType<typeof parseDutyInfo> = null;
    let procedures: ProcedureInfo[] = [];
    if (effectiveChosenCode && /^\d{12}$/.test(effectiveChosenCode)) {
      const pool = getPool();
      const r = await pool.query<{
        duty_en: string | null;
        duty_ar: string | null;
        procedures: string | null;
      }>(
        `SELECT duty_en, duty_ar, procedures FROM hs_codes WHERE code = $1`,
        [effectiveChosenCode],
      );
      const row = r.rows[0];
      if (row) {
        dutyInfo = parseDutyInfo(row.duty_en, row.duty_ar);
        procedures = await lookupProcedures(row.procedures, req.log);
      }
    }

    const totalLatency = Date.now() - t0;

    const loggedStatus = accepted ? 'best_effort' : decision.decisionStatus;
    const loggedReason = accepted ? 'best_effort_heading' : decision.decisionReason;
    const loggedConfidence: 'high' | 'medium' | 'low' | null = accepted
      ? 'low'
      : (decision.confidenceBand ?? null);
    const loggedChosen = accepted ? accepted.code : effectiveChosenCode;

    // logEvent returns null on DB failure → request_id omitted, classification still ships.
    const requestId = await logEvent({
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
        research_web_kind: researchWeb?.kind ?? null,
        research_web_latency_ms: researchWeb?.latencyMs ?? null,
        best_effort_invoked: bestEffort !== null,
        best_effort_specificity: accepted ? accepted.specificity : null,
        cleanup_invoked: cleanup?.invoked ?? null,
        cleanup_kind: cleanup?.invoked === 'llm' ? cleanup.kind : null,
        cleanup_effective: cleanup?.invoked === 'llm' ? cleanup.effective : null,
        cleanup_attributes_count: cleanup?.attributes.length ?? 0,
        cleanup_stripped_count: cleanup?.stripped.length ?? 0,
        cleanup_latency_ms: cleanup?.latencyMs ?? 0,
        branch_rank_invoked: branchRank?.invoked ?? null,
        branch_rank_picker_choice: branchRank ? decision.chosenCode : null,
        branch_rank_top_pick: branchRank?.topPick ?? null,
        branch_rank_overrode:
          branchRank?.invoked === 'llm' && !branchRank.agreesWithPicker,
        branch_rank_latency_ms: branchRank?.latencyMs ?? 0,
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
      modelCalls,
      embedderVersion: EMBEDDER_VERSION(),
      llmModel: accepted ? accepted.model : (llm?.llmModel ?? null),
      totalLatencyMs: totalLatency,
      error: null,
      rationale: accepted ? accepted.rationale : (decision.rationale ?? null),
    }, req.log);

    // Best-effort response (verify-toggle gated on the frontend).
    if (accepted) {
      return {
        ...withRequestId(requestId),
        decision_status: 'best_effort' as const,
        decision_reason: 'best_effort_heading' as const,
        confidence_band: 'low' as const,
        result: {
          code: accepted.code,
          // Best-effort returns a chapter-level prefix, not a leaf — no EN/AR lookup.
          description_en: null,
          description_ar: null,
        },
        rationale: accepted.rationale,
        alternatives: [],
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

    // Researcher-declined OR best-effort-no-signal → needs_clarification, no alternatives.
    if (
      (stage === 'unknown' && research && research.kind === 'unknown') ||
      noSignalBestEffort
    ) {
      return {
        ...withRequestId(requestId),
        decision_status: 'needs_clarification' as const,
        decision_reason: 'brand_not_recognised' as const,
        alternatives: [],
        interpretation: buildInterpretation({ description, stage, effectiveDescription, research, cleanup }),
        model: {
          embedder: EMBEDDER_VERSION(),
          llm: null,
          ...(research && research.kind === 'recognised' ? { researcher: research.model } : {}),
          ...(research && research.kind === 'unknown' ? { researcher: research.model } : {}),
          ...(cleanup && cleanup.invoked === 'llm' && cleanup.model
            ? { cleanup: cleanup.model }
            : {}),
        },
      };
    }

    // Look up the chosen code's catalog row once across all three sources.
    const chosenCandidate = effectiveChosenCode
      ? candidates.find((c) => c.code === effectiveChosenCode)
      : undefined;
    const chosenLeaf = effectiveChosenCode
      ? branchLeaves?.find((l) => l.code === effectiveChosenCode)
      : undefined;
    const chosenHeadingMatch =
      headingLevelPromoted && headingLevelPromoted.code === effectiveChosenCode
        ? headingLevelPromoted
        : undefined;

    // Standard envelope (accepted / needs_clarification / degraded).
    return {
      ...withRequestId(requestId),
      decision_status: decision.decisionStatus,
      decision_reason: decision.decisionReason,
      ...(decision.confidenceBand && { confidence_band: decision.confidenceBand }),
      ...(effectiveChosenCode && {
        result: {
          code: effectiveChosenCode,
          description_en: trimCatalogDashes(
            chosenHeadingMatch?.description_en ??
              chosenCandidate?.description_en ??
              chosenLeaf?.description_en ??
              null,
          ),
          description_ar: trimCatalogDashes(
            chosenHeadingMatch?.description_ar ??
              chosenCandidate?.description_ar ??
              chosenLeaf?.description_ar ??
              null,
          ),
          // Null on branch-rank override: the code may not be in `candidates`.
          retrieval_score: chosenCandidate ? round4(chosenCandidate.rrf_score) : null,
          duty: dutyInfo,
          ...(procedures.length > 0 && { procedures }),
        },
      }),
      alternatives,
      ...(decision.rationale && { rationale: decision.rationale }),
      ...(decision.missingAttributes.length > 0 && {
        missing_attributes: decision.missingAttributes,
      }),
      ...(branchRank && branchRank.invoked === 'llm' && !branchRank.agreesWithPicker
        ? {
            branch_rank_override: {
              picker_choice: decision.chosenCode,
              branch_rank_choice: branchRank.topPick,
            },
          }
        : {}),
      interpretation: buildInterpretation({ description, stage, effectiveDescription, research, cleanup }),
      model: {
        embedder: EMBEDDER_VERSION(),
        llm: llm?.llmModel ?? null,
        ...(research && research.kind === 'recognised' ? { researcher: research.model } : {}),
        ...(cleanup && cleanup.invoked === 'llm' && cleanup.model
          ? { cleanup: cleanup.model }
          : {}),
        ...(branchRank && branchRank.invoked === 'llm' && branchRank.model
          ? { branch_rank: branchRank.model }
          : {}),
      },
    };
  });
}
