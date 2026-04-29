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
import { getPool } from '../db/client.js';
import { loadThresholds, isEnabled } from '../decision/setup-meta.js';
import { evaluateGate } from '../decision/evidence-gate.js';
import { llmPick } from '../decision/llm-pick.js';
import { resolve } from '../decision/resolve.js';
import { logEvent } from '../decision/log-event.js';
import { detectLang } from '../util/lang.js';
import { EMBEDDER_VERSION } from '../embeddings/embedder.js';
import { env } from '../config/env.js';
import { checkUnderstanding } from '../preprocess/check-understanding.js';
import { researchInput, type ResearchOutcome } from '../preprocess/research.js';
import {
  researchInputWithWeb,
  type ResearchWithWebOutcome,
} from '../preprocess/research-with-web.js';
import { filterAlternatives } from '../decision/filter-alternatives.js';
import { enumerateBranch, type BranchLeaf } from '../decision/branch-enumerate.js';
import { parseDutyInfo } from '../decision/duty-info.js';
import { rankBranch, type BranchRankResult } from '../decision/branch-rank.js';
import type { MerchantCleanupResult } from '../preprocess/merchant-cleanup.js';
import { round4 } from '../util/score.js';
import { withRequestId, trimAlternativeDashes, trimCatalogDashes } from './_helpers.js';
import type { ModelCallTrace } from '../llm/structured-call.js';
import type { LlmStatus } from '../llm/client.js';
import { buildInterpretation, type InterpretationStage } from '../decision/interpretation.js';
import { runCleanupStage } from '../decision/stages/cleanup-stage.js';
import { runBestEffortStage } from '../decision/stages/best-effort-stage.js';

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
    let researchWeb: ResearchWithWebOutcome | null = null;
    let cleanup: MerchantCleanupResult | null = null;

    /**
     * Per-request trace of every LLM call that fired, in the order they
     * fired. Each stage pushes a ModelCallTrace when it actually invokes
     * the LLM (skipped stages — e.g. cleanup short-circuited by
     * looksClean — push nothing). The aggregator replaces the older
     * 50-line conditional-spread block in the logEvent payload, where
     * one branch per stage was needed to decide whether each trace was
     * present.
     *
     * `recordCall` is a tiny helper rather than a class so any module
     * that wants to push (current: this file only) can do so with one
     * line. If H2 splits this file into stage modules, each stage will
     * accept the array and push directly — same shape, no new type.
     */
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

    // ---- Stage 0: merchant-input cleanup (decision/stages/cleanup-stage.ts) -
    const cleanupStage = await runCleanupStage({
      description,
      thresholds: t,
      modelCalls,
    });
    cleanup = cleanupStage.cleanup;
    effectiveDescription = cleanupStage.effectiveDescription;
    stage = cleanupStage.stage;

    // ---- Stage 1: retrieve top-K on the (possibly cleaned) input ---------
    const norm1 = digitNormalize(effectiveDescription, known);
    let candidates: Candidate[] = await retrieveCandidates(norm1.cleanedText, {
      leavesOnly: true,
      ...(norm1.prefixBias ? { prefixBias: norm1.prefixBias } : {}),
      topK: t.RETRIEVAL_TOP_K_describe,
    });

    // ---- Stage 2: did retrieval understand? ------------------------------
    // V3 (ADR-0020): composite signal. Chapter coherence alone missed the
    // "coherent but wrong-family" failure mode (Loewe Puzzle bag → 4205
    // leather articles). Adding noun-alignment catches it: cleanup
    // extracted "bag", retrieval surfaced "leather articles / desk pads /
    // buckle parts" — none mention "bag" → understanding returns weak,
    // researcher runs.
    const customsNoun =
      cleanup && cleanup.invoked === 'llm' && cleanup.kind === 'product'
        ? cleanup.effective
        : null;
    // Cleanup explicitly tagged the input as merchant shorthand → there's
    // no customs noun to align against. Coherence-only is unsafe in this
    // case (e.g. "Arizona BFBC Mocca43" can lexically anchor to chapter 01
    // via "Arab" → Arab horses, with all top results in chapter 01 →
    // coherence says "understood" — but on a wrong family). Force-route
    // shorthand inputs to the researcher so the LLM (and on UNKNOWN, web
    // search) gets a chance to identify the product properly.
    const cleanupIsShorthand =
      cleanup && cleanup.invoked === 'llm' && cleanup.kind === 'merchant_shorthand';
    const understanding = checkUnderstanding(candidates, {
      maxDistinctChapters: t.UNDERSTOOD_MAX_DISTINCT_CHAPTERS,
      topK: t.UNDERSTOOD_TOP_K_describe,
      ...(customsNoun ? { customsNoun } : {}),
    });
    if (cleanupIsShorthand && understanding.understood) {
      // Override the coherence-only strong verdict for shorthand inputs.
      // We treat it as `weak` so the researcher fires; if the researcher
      // recognises, we re-retrieve. If web research is enabled and the
      // standard researcher returns UNKNOWN, web research fires next.
      understanding.understood = false;
      understanding.strength = 'weak';
      understanding.reason = 'noun_misaligned';
    }

    if (!understanding.understood) {
      // ---- Stage 2b: researcher --------------------------------------------
      // Always research on the original input — the researcher is what
      // resolves merchant shorthand like "Arizona BFBC Mocca43" by world
      // knowledge, and feeding it the cleaned (likely empty) text would
      // strip the very signal it needs.
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
        // Phase F escalation: when the standard researcher returns UNKNOWN
        // (no signal from Sonnet's pre-training memory) AND the feature
        // flag is on, fire the web-augmented researcher. One Anthropic
        // hosted web_search call lets Sonnet pull external evidence and
        // re-attempt identification with citable snippets. Caps at one
        // search per request — bounded latency (~3-5s) and bounded cost.
        // If web research recognises the product, we treat the outcome
        // exactly as if the standard researcher had recognised it:
        // re-retrieve on the canonical phrase and continue.
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
            // Web research returned 'unknown' or 'failed'. Honest
            // abstention — same as standard researcher's UNKNOWN path.
            stage = 'unknown';
          }
        } else {
          stage = 'unknown';
        }
        // Researcher saw the input and explicitly declined to identify. We
        // do not run the picker on candidates we already know are wrong.
        // Whether we attempt best-effort here depends on the feature flag —
        // see the unified post-picker tail below.
      }
      // research.kind === 'failed' → stage stays 'cleaned'/'passthrough';
      // the gate will likely refuse on the retrieval, which is the correct
      // degraded mode.
    }

    // ---- Stage 2c: heading-padded code injection (V3 — bounded assist) ---
    // V3 (ADR-0020) demotes this from "synthetic fallback that keeps the
    // picker alive" to "bounded assist". Reviewer's concern: previously
    // injection fired whenever retrieval had any top result, which could
    // add a wrong heading (Loewe Puzzle bag's top result was 4205 —
    // wrong family — and we were injecting 420500000000). Stage 2a's V3
    // composite signal would now route Loewe Puzzle bag through the
    // researcher first, but as a defence-in-depth measure injection only
    // fires when:
    //   1. understanding strength === 'strong' (Stage 2a is fully
    //      satisfied — chapter coherent AND noun-aligned), AND
    //   2. the customs noun (if known) appears in the heading-padded
    //      row's description.
    // Both gates are satisfied → inject. Either fails → skip injection
    // and let retrieval/picker decide on real candidates only.
    if (candidates.length > 0 && understanding.strength === 'strong') {
      const top = candidates[0]!;
      const headingPrefix = top.code.slice(0, 4); // e.g. "4202"
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
          // Second gate: when we have a customs noun, ensure THE HEADING
          // ITSELF describes that noun. The heading description is the
          // long generic enumeration of every product type at this
          // heading; if "bag" / "perfume" / etc isn't anywhere in it,
          // injection would still be misaligned and we skip.
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
                rrf_score: top.rrf_score, // tied with the top so it visibly competes
              },
            ];
          }
        }
      }
    }

    // ---- Stage 3 + 4: gate + picker (called at most once) ---------------
    // Pass effectiveDescription so the gate can apply the thin-input +
    // cross-chapter-spread refusal (books/cosmetics confusion). Other
    // routes (expand/boost) don't need it — they retrieve under a
    // narrowed prefix and don't suffer the same lexical-spread failure.
    const gate = evaluateGate(
      candidates,
      {
        minScore: t.MIN_SCORE_describe,
        minGap: t.MIN_GAP_describe,
      },
      effectiveDescription,
    );

    let llm = null;
    // V3 (ADR-0020): Stage 3 is a real gate again. The picker runs IFF
    // the gate passed. Previously a soft-refuse-with-heading-padded
    // escape hatch let the picker run on weak retrieval, which the
    // reviewer correctly diagnosed as a trust-boundary contradiction
    // ("the gate fails, but here's a synthetic candidate to make the
    // picker run anyway"). With Stage 2a's V3 composite signal catching
    // the wrong-family case earlier, the escape hatch isn't needed.
    //
    // Picker runs when ALL of:
    //   - researcher didn't flag the input as unknown
    //   - we have candidates
    //   - the gate passed
    // Otherwise: route to best-effort fallback.
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

    // ---- Stage 5 + heading-level promotion (decision/stages/best-effort-stage.ts) -
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
    // Apply the patch the stage returned. Mutating `decision` here (rather
    // than inside the stage) keeps the side effect explicit at the route
    // level — this is the only place `decision` ever changes after it's
    // returned by `resolve()`.
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
      /**
       * Where this alternative came from. Lets the UI render a per-row
       * badge so the user understands which scope they're looking at.
       *   branch_8 — same national subheading as the chosen code
       *   branch_6 — same HS-6 subheading (fallback when HS-8 was sparse)
       *   branch_4 — same HS-4 heading (rare; only via deeper widening)
       *   rrf      — filtered retrieval candidate (final fallback)
       *   undefined — non-accepted path; legacy RRF without source label
       */
      source?: 'branch_8' | 'branch_6' | 'branch_4' | 'rrf';
      // Phase 3 — populated only when branch-rank ran. Per-row reasoning
      // tells the user why each sibling fits / doesn't fit. `fit` and
      // `reason` are missing on rows that came from branch enumeration
      // alone (Phase 1) or from filtered RRF (non-accepted paths).
      rank?: number;
      fit?: 'fits' | 'partial' | 'excludes';
      reason?: string;
    };
    let alternatives: Alt[];
    let branchLeaves: BranchLeaf[] | null = null;
    let branchRank: BranchRankResult | null = null;
    /**
     * The code we ship to the user. Defaults to the picker's pick. If
     * branch-rank is enabled AND ran successfully AND its #1 differs from
     * the picker's pick, this is overridden to branch-rank's choice. The
     * picker's original choice is kept in the event log under
     * `branch_rank_overrode` for offline review.
     */
    let effectiveChosenCode: string | null = decision.chosenCode;

    if (isAcceptedFamily && decision.chosenCode) {
      branchLeaves = await enumerateBranch({
        chosenCode: decision.chosenCode,
        prefixLength: t.BRANCH_PREFIX_LENGTH as 4 | 6 | 8,
        // Show at least 3 non-chosen siblings — gives the user a real
        // comparison set even when the HS-8 branch is sparse (e.g.
        // 1509.20.00 = Extra virgin olive oil has 1 leaf at HS-8 but 4
        // at HS-6). Tunable via setup_meta.ALTERNATIVES_MIN_SHOWN.
        minSiblings: t.ALTERNATIVES_MIN_SHOWN,
        maxLeaves: t.BRANCH_MAX_LEAVES,
      });

      // Option B (confident-pick fast path): skip branch-rank when
      // retrieval is decisively confident. Branch-rank's value-add is
      // re-evaluating ambiguous within-branch ties; on an input like
      // "men white shirt" where retrieval converges sharply on a single
      // leaf (top-1 RRF score is well above top-2), the rerank almost
      // always agrees with the picker — wasting 3-5s of Sonnet time on
      // every confident classification.
      //
      // The threshold: top2Gap > 3x the gate's MIN_GAP_describe floor.
      // Gate accepts at MIN_GAP; "confident" is "more than 3x clearer
      // than the minimum we'd accept." Empirically separates the
      // shirt-class inputs (large gaps) from the ambiguous-tie cases
      // branch-rank is designed to catch.
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
        // Branch-rank is overriding the picker. We trust it because it
        // saw the FULL HS-8 branch; the picker only saw 8 RRF top hits.
        effectiveChosenCode = branchRank.effectiveCode;
      }

      // Build a fast source-lookup so we can carry the source label even
      // through branch-rank's reordered output (branch-rank doesn't know
      // about source — it just ranks codes).
      const sourceByCode = new Map(branchLeaves.map((l) => [l.code, l.source]));

      // Render the alternatives. The chosen code itself is intentionally
      // EXCLUDED from this list — it's already shipped at top-level on
      // `result.code`. Including it here led to a frontend bug where
      // alternatives appeared to start numbering at "2", confusing
      // users about which row was the chosen one. The chosen code is
      // the result; alternatives are the things you considered instead.
      //
      //   - branch-rank ran successfully → use its rank order minus
      //     chosen; attach fit + reason + source to each row.
      //   - Otherwise → catalog order minus chosen, no fit/reason.
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

      // Layer 3 — RRF fallback. If branch enumeration (even after widening)
      // produced fewer than ALTERNATIVES_MIN_SHOWN total rows, top up from
      // the filtered retrieval candidates. Same MIN_ALT_SCORE / cross-chapter
      // ratio rules as Phase 0 still apply, so we never re-introduce noise
      // (bathing caps, horses) — just genuinely close hits the catalog tree
      // doesn't surface.
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

    // Strip catalog tree-depth dashes (e.g. "- - Other :") from every
    // alternative's EN+AR description before they leave this handler.
    // Mutates in place so the same array reference flows into both
    // logEvent (persisted) and the response (shipped) — descriptions
    // can't drift between trace replay and the original response.
    trimAlternativeDashes(alternatives);

    // Phase 5 submission description used to be generated inline here.
    // It's now lazy: the frontend calls GET /classify/newDescription
    // ?request_id=<uuid> when the user is ready to copy the Arabic text
    // into the ZATCA declaration form. Cuts ~3-5s of Haiku time off
    // every accepted classification.

    // ---- Duty + procedures lookup ----------------------------------------
    // ZATCA's catalog stores duty rate (e.g. "5 %") and an import procedures
    // reference per leaf. Brokers need both — duty informs the duty-paid
    // calculation, procedures hint at SABER / SFDA / etc compliance steps
    // required at the port. Single SELECT per request; ~5ms. No-op when
    // we don't have a 12-digit chosen code (e.g. best-effort prefix).
    let dutyInfo: ReturnType<typeof parseDutyInfo> = null;
    let proceduresRaw: string | null = null;
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
        proceduresRaw = row.procedures?.trim() || null;
      }
    }

    const totalLatency = Date.now() - t0;

    // Log the event with the *final* decision status — best_effort if the
    // fallback produced a heading, otherwise whatever resolve() returned.
    const loggedStatus = accepted ? 'best_effort' : decision.decisionStatus;
    const loggedReason = accepted ? 'best_effort_heading' : decision.decisionReason;
    const loggedConfidence: 'high' | 'medium' | 'low' | null = accepted
      ? 'low'
      : (decision.confidenceBand ?? null);
    // The "chosen code" we log is the FINAL one shipped to the user — i.e.
    // branch-rank's override if it overrode the picker, else the picker's
    // original choice (or best-effort's, on the fallback path). The
    // picker's pre-override choice is logged separately as
    // `branch_rank_picker_choice` for offline review.
    const loggedChosen = accepted ? accepted.code : effectiveChosenCode;

    // We await logEvent so we get the inserted row's UUID back as the
    // request_id we expose on the response. logEvent returns null (not
    // throws) on DB failure, so a logging outage degrades to "no
    // request_id on the response" rather than "the whole classification
    // 500s". The user's classification still ships normally.
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
        // Phase F observability: track when web research escalation
        // fired and what it returned. Lets us tune the escalation
        // threshold and the prompt without re-running traffic.
        research_web_kind: researchWeb?.kind ?? null,
        research_web_latency_ms: researchWeb?.latencyMs ?? null,
        best_effort_invoked: bestEffort !== null,
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
        // Phase 3 — branch-rank observability. `branch_rank_overrode`
        // captures the rare case where Sonnet's full-branch view rerouted
        // away from the picker's choice. The picker's pre-override pick
        // is recorded so we can audit overrides offline and tune the
        // picker prompt over time.
        branch_rank_invoked: branchRank?.invoked ?? null,
        branch_rank_picker_choice: branchRank ? decision.chosenCode : null,
        branch_rank_top_pick: branchRank?.topPick ?? null,
        branch_rank_overrode:
          branchRank?.invoked === 'llm' && !branchRank.agreesWithPicker,
        branch_rank_latency_ms: branchRank?.latencyMs ?? 0,
        // (submission-description observability now lives on the
        // GET /classify/newDescription route — describe.ts no longer
        // generates submission text on the critical path.)
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
      // Aggregated by `recordCall(...)` at each LLM site upstream, in
      // the order calls fired. Replaces a former 50-line conditional
      // block where every stage had its own spread + null check.
      modelCalls,
      embedderVersion: EMBEDDER_VERSION(),
      llmModel: accepted ? accepted.model : (llm?.llmModel ?? null),
      totalLatencyMs: totalLatency,
      error: null,
      // Best-effort fallback ships its own rationale; otherwise the picker's.
      // resolve() already maps null-rationale paths (degraded, gate-failed)
      // to decision.rationale = null, so this single expression covers all.
      rationale: accepted ? accepted.rationale : (decision.rationale ?? null),
    }, req.log);

    // ---- Response shape --------------------------------------------------

    // Best-effort response (verify-toggle gated on the frontend).
    if (accepted) {
      return {
        // Phase 4 — request id surfaced on every response so the frontend
        // can deep-link to /trace/:id and POST feedback. Null when logging
        // failed (degraded mode); UI hides the trace link in that case.
        ...withRequestId(requestId),
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
        // No alternatives on the best-effort path. The RRF top hits were
        // computed against the raw input — when best-effort had to fire,
        // retrieval had already failed the gate, so those hits would be
        // wrong-family noise (e.g. donkeys ranked against "Asma Said").
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

    // Researcher-declined OR best-effort-no-signal response. Both paths
    // mean "we can't see a product here" — emit needs_clarification with
    // empty alternatives, no verify-toggle. The frontend should render a
    // soft "we couldn't identify a product — try a fuller description"
    // message rather than the orange "best effort — verify" badge.
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
    // (Previously this called candidates.find five times in the response
    // builder — once per field — which obscured intent and re-scanned the
    // candidate list. Same priority order: heading-promotion → RRF top-K →
    // enumerated branch leaves.)
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
          // retrieval_score is only meaningful when the chosen code came from
          // the picker (RRF top-K); on a branch-rank override, the code may
          // not be in `candidates` and the score has no meaning. Null then.
          retrieval_score: chosenCandidate ? round4(chosenCandidate.rrf_score) : null,
          // Duty rate + import procedures from the ZATCA catalog. duty is
          // a structured object distinguishing percentages (`rate_percent`)
          // from status words (`status_en` / `status_ar` for "Exempted" /
          // "Prohibited from Importing"). procedures is the raw reference
          // code from the catalog (e.g. "21" → SABER conformity).
          duty: dutyInfo,
          procedures: proceduresRaw,
        },
      }),
      alternatives,
      ...(decision.rationale && { rationale: decision.rationale }),
      ...(decision.missingAttributes.length > 0 && {
        missing_attributes: decision.missingAttributes,
      }),
      // Phase 3 — surface a branch-rank "overrode" notice when relevant so
      // the frontend can render a small badge ("Picker chose X; branch-rank
      // overrode to Y because the wider HS-8 view showed a better fit"). On
      // the common path where ranks agree, we don't emit anything.
      ...(branchRank && branchRank.invoked === 'llm' && !branchRank.agreesWithPicker
        ? {
            branch_rank_override: {
              picker_choice: decision.chosenCode,
              branch_rank_choice: branchRank.topPick,
            },
          }
        : {}),
      // ZATCA-safe submission description is now generated lazily.
      // When the frontend needs it, it calls GET /classify/newDescription
      // ?request_id=<request_id from this response>.
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

