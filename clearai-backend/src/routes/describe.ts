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
import { rankBranch, type BranchRankResult } from '../decision/branch-rank.js';
import {
  generateSubmissionDescription,
  type SubmissionDescriptionResult,
} from '../decision/submission-description.js';
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

    // ---- Stage 2c: heading-padded code injection ------------------------
    // Retrieval often misses the heading-level row (xxxx00000000) because
    // its description is long and generic — the embedder dilutes it
    // against a short input. But the picker's heading-fallback rule can
    // only fire when the heading-padded code is in the candidate set. So:
    // if the retrieval's top candidate's chapter+heading has a
    // corresponding heading-padded row in hs_codes, splice it into the
    // candidate list. We give it a synthetic RRF score equal to the
    // current top so it visibly competes; the picker decides whether to
    // pick it (heading-level commit) or a leaf below it.
    if (candidates.length > 0) {
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

    // ---- Stage 3 + 4: gate + picker (called at most once) ---------------
    const gate = evaluateGate(candidates, {
      minScore: t.MIN_SCORE_describe,
      minGap: t.MIN_GAP_describe,
    });

    let llm = null;
    // Run the picker when:
    //   - the gate passed (strong retrieval), OR
    //   - the gate refused for soft reasons (weak_retrieval /
    //     ambiguous_top_candidates) BUT we have candidates AND the
    //     candidate set includes a heading-padded code in the same family.
    //     The picker's heading-fallback rule will commit to that heading,
    //     which is a legitimate ZATCA-accepted classification rather than
    //     forcing the input through best-effort fallback.
    //   - never when the researcher flagged the input as unknown — we
    //     already know retrieval doesn't have the right product.
    //   - never on `invalid_prefix` (the candidate set is empty).
    const skipPicker = stage === 'unknown';
    const gateSoftRefuse =
      !gate.passed &&
      'reason' in gate &&
      (gate.reason === 'weak_retrieval' || gate.reason === 'ambiguous_top_candidates');
    const hasHeadingPadded = candidates.some(
      (c) => /^\d{4}0{8}$/.test(c.code), // 4 digits + 8 zeros
    );
    const runPickerOnSoftRefuse = gateSoftRefuse && hasHeadingPadded;
    if (
      !skipPicker &&
      candidates.length > 0 &&
      (gate.passed || runPickerOnSoftRefuse)
    ) {
      llm = await llmPick({
        kind: 'describe',
        query: effectiveDescription,
        candidates: candidates.slice(0, t.PICKER_CANDIDATES_describe),
        model: env().LLM_MODEL_STRONG,
      });
    }

    // If the picker ran on a soft-refused gate AND committed to a code,
    // we treat the gate as "passed" for resolve()'s purposes — the picker's
    // commit (per its heading-fallback rule) is the authoritative signal,
    // and the heading-level commit is a legitimate accepted ZATCA code.
    const effectiveGate =
      runPickerOnSoftRefuse && llm && llm.chosenCode
        ? { ...gate, passed: true as const }
        : gate;
    const decision = resolve({ gate: effectiveGate, llm });

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
    let accepted: Extract<BestEffortOutcome, { kind: 'ok' }> | null =
      bestEffort && bestEffort.kind === 'ok' ? bestEffort : null;

    // ---- Heading-level acceptance promotion (ADR-0019) -------------------
    // ZATCA recognises heading-padded 12-digit codes (e.g. `420200000000`,
    // `640300000000`) as valid customs declarations with published duty
    // rates. When best-effort identified a 4-digit HS heading we'd
    // otherwise wrap it in a "verify before use" warning card — but the
    // 12-digit form of that same heading IS a legitimate accepted code.
    // Look up `<heading>00000000` in hs_codes; if it exists as a leaf,
    // promote the response from best_effort → accepted with confidence
    // band 'medium' and decision_reason 'heading_level_match'. The
    // promotion only fires when:
    //   - best-effort produced a 4-digit code AND the gate failed
    //     upstream (i.e. the standard accepted path didn't already
    //     produce a 12-digit pick).
    //   - the heading-padded row exists in hs_codes as is_leaf=true.
    // Either condition unmet → leave the response as best_effort, the
    // existing verify-toggle UI applies.
    let headingLevelPromoted: {
      code: string;
      description_en: string | null;
      description_ar: string | null;
      rationale: string;
      missingHint: string;
    } | null = null;
    if (accepted && accepted.specificity === 4 && /^\d{4}$/.test(accepted.code)) {
      const headingCode = `${accepted.code}00000000`;
      const pool = getPool();
      const r = await pool.query<{
        description_en: string | null;
        description_ar: string | null;
      }>(
        `SELECT description_en, description_ar FROM hs_codes WHERE code = $1 AND is_leaf = true`,
        [headingCode],
      );
      const row = r.rows[0];
      if (row) {
        // Promote. We synthesise a rationale that explains the
        // heading-level commit honestly: it's a real ZATCA leaf,
        // duty is published, but a sub-heading would be more
        // specific if the relevant attribute is documented.
        headingLevelPromoted = {
          code: headingCode,
          description_en: row.description_en,
          description_ar: row.description_ar,
          rationale: `${accepted.rationale} Accepted at heading level (${accepted.code}) — ZATCA accepts this code as a valid declaration. Adding the missing classification attribute (typically material) would refine to a sub-heading.`,
          missingHint:
            'Adding the material (e.g. leather / textile / plastic) to your input would refine this to a sub-heading.',
        };
        // Suppress the best_effort path so downstream code emits the
        // standard accepted envelope instead.
        accepted = null;
        decision.decisionStatus = 'accepted';
        decision.decisionReason = 'heading_level_match';
        decision.confidenceBand = 'medium';
        decision.chosenCode = headingCode;
        decision.rationale = headingLevelPromoted.rationale;
      }
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

      // Phase 3 — Sonnet rerank with per-row reasoning, optionally
      // overriding the picker. Feature-flagged off by default; flip
      // BRANCH_RANK_ENABLED in setup_meta to enable.
      branchRank = await rankBranch({
        query: effectiveDescription,
        chosenCode: decision.chosenCode,
        leaves: branchLeaves,
        opts: {
          enabled: t.BRANCH_RANK_ENABLED === 1,
          maxTokens: t.BRANCH_RANK_MAX_TOKENS,
        },
      });

      if (branchRank.invoked === 'llm' && !branchRank.agreesWithPicker) {
        // Branch-rank is overriding the picker. We trust it because it
        // saw the FULL HS-8 branch; the picker only saw 8 RRF top hits.
        effectiveChosenCode = branchRank.effectiveCode;
      }

      // Build a fast source-lookup so we can carry the source label even
      // through branch-rank's reordered output (branch-rank doesn't know
      // about source — it just ranks codes).
      const sourceByCode = new Map(branchLeaves.map((l) => [l.code, l.source]));

      // Render the alternatives:
      //   - When branch-rank ran successfully → use its rank order, attach
      //     fit + reason + source to each row. The (possibly overridden)
      //     chosen code is at rank=1.
      //   - Otherwise → fall back to catalog order with chosen pinned to
      //     the front, no fit/reason.
      if (branchRank.invoked === 'llm') {
        alternatives = branchRank.ranking
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
        const chosen = branchLeaves.find((l) => l.code === effectiveChosenCode);
        const others = branchLeaves.filter((l) => l.code !== effectiveChosenCode);
        const ordered = chosen ? [chosen, ...others] : branchLeaves;
        alternatives = ordered.slice(0, t.ALTERNATIVES_SHOWN_describe).map((l) => ({
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
            retrieval_score: Number(c.rrf_score.toFixed(4)),
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
        retrieval_score: Number(c.rrf_score.toFixed(4)),
        source: 'rrf' as const,
      }));
    }

    // ---- Phase 5: ZATCA-safe submission description ----------------------
    // Generated only on the accepted path with a real 12-digit leaf chosen.
    // Anchored on `effectiveDescription` (the cleaned/researched product),
    // not on the raw user input — this prevents brand/SKU leakage into the
    // customs declaration. Deterministic distinctness check vs catalog AR
    // runs after the LLM; falls back to a prefix mutator on failure so we
    // never ship an empty submission field.
    let submission: SubmissionDescriptionResult | null = null;
    if (
      isAcceptedFamily &&
      effectiveChosenCode &&
      /^\d{12}$/.test(effectiveChosenCode) &&
      t.SUBMISSION_DESC_ENABLED === 1
    ) {
      // Look up the catalog descriptions for the chosen code. Same fallback
      // logic as the response-side `result` block (candidates → branchLeaves).
      const cand = candidates.find((c) => c.code === effectiveChosenCode);
      const leaf = branchLeaves?.find((l) => l.code === effectiveChosenCode);
      const catalogAr = cand?.description_ar ?? leaf?.description_ar ?? null;
      const catalogEn = cand?.description_en ?? leaf?.description_en ?? null;

      submission = await generateSubmissionDescription({
        effectiveDescription,
        chosenCode: effectiveChosenCode,
        catalogDescriptionAr: catalogAr,
        catalogDescriptionEn: catalogEn,
        opts: {
          enabled: true,
          maxTokens: t.SUBMISSION_DESC_MAX_TOKENS,
        },
      });
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
        // Phase 5 — submission-description observability. Lets us audit
        // how often the deterministic distinctness check trips the
        // fallback path, and whether the differs-from-catalog rule is
        // ever bypassed in production.
        submission_invoked: submission?.invoked ?? null,
        submission_differs_from_catalog: submission?.differsFromCatalog ?? null,
        submission_latency_ms: submission?.latencyMs ?? 0,
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
        ...(branchRank && branchRank.invoked === 'llm' && branchRank.model
          ? [
              {
                model: branchRank.model,
                latency_ms: branchRank.latencyMs,
                status: 'ok' as const,
              },
            ]
          : []),
        ...(submission && submission.invoked === 'llm' && submission.model
          ? [
              {
                model: submission.model,
                latency_ms: submission.latencyMs,
                status: 'ok' as const,
              },
            ]
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
    });

    // ---- Response shape --------------------------------------------------

    // Best-effort response (verify-toggle gated on the frontend).
    if (accepted) {
      return {
        // Phase 4 — request id surfaced on every response so the frontend
        // can deep-link to /trace/:id and POST feedback. Null when logging
        // failed (degraded mode); UI hides the trace link in that case.
        ...(requestId ? { request_id: requestId } : {}),
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
        ...(requestId ? { request_id: requestId } : {}),
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
      ...(requestId ? { request_id: requestId } : {}),
      decision_status: decision.decisionStatus,
      decision_reason: decision.decisionReason,
      ...(decision.confidenceBand && { confidence_band: decision.confidenceBand }),
      ...(effectiveChosenCode && {
        result: {
          code: effectiveChosenCode,
          // Look up descriptions in priority order:
          //   1. Heading-level promotion (ADR-0019) — we already have the
          //      catalog row from the dedicated lookup; use that.
          //   2. Original RRF candidates (the picker's normal path).
          //   3. branchLeaves (covers branch-rank overrides whose code
          //      may not be in the RRF top-K but IS in the enumerated
          //      branch).
          description_en:
            (headingLevelPromoted && headingLevelPromoted.code === effectiveChosenCode
              ? headingLevelPromoted.description_en
              : null) ??
            candidates.find((c) => c.code === effectiveChosenCode)?.description_en ??
            branchLeaves?.find((l) => l.code === effectiveChosenCode)?.description_en ??
            null,
          description_ar:
            (headingLevelPromoted && headingLevelPromoted.code === effectiveChosenCode
              ? headingLevelPromoted.description_ar
              : null) ??
            candidates.find((c) => c.code === effectiveChosenCode)?.description_ar ??
            branchLeaves?.find((l) => l.code === effectiveChosenCode)?.description_ar ??
            null,
          // retrieval_score is only meaningful when the chosen code came from
          // the picker (RRF top-K); on a branch-rank override, the code may
          // not be in `candidates` and the score has no meaning. Null in
          // that case, matching the AlternativeCandidate convention.
          retrieval_score:
            candidates.find((c) => c.code === effectiveChosenCode)
              ? Number(
                  (
                    candidates.find((c) => c.code === effectiveChosenCode)?.rrf_score ?? 0
                  ).toFixed(4),
                )
              : null,
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
      // Phase 5 — ZATCA-safe submission description. Only emitted on the
      // accepted path with a real chosen leaf. The frontend renders a
      // copy-able card under the chosen code with a "differs from catalog"
      // checkmark and a "review before submission" warning.
      ...(submission && submission.invoked !== 'disabled'
        ? {
            submission_description: {
              description_ar: submission.descriptionAr,
              description_en: submission.descriptionEn,
              rationale: submission.rationale,
              differs_from_catalog: submission.differsFromCatalog,
              source: submission.invoked, // 'llm' | 'guard_fallback' | 'llm_failed'
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
        ...(submission && submission.invoked === 'llm' && submission.model
          ? { submission: submission.model }
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
