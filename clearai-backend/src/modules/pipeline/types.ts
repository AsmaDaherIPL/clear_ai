/**
 * Pipeline discriminated-union contracts — canonical location (PR 13).
 *
 * Single load-bearing types file. Every stage output is a tagged union;
 * downstream consumers branch on `kind` (or equivalent discriminator)
 * rather than probing nullable fields.
 *
 * Architecture:
 *
 *   parse -> (identify_fast || merchant_resolution) -> maybe identify_web
 *     -> scope_selection -> multi_arm_retrieval + union + rerank
 *     -> picker -> verifier -> (submission || sanity) -> PipelineResult
 *
 * This file is PURE TYPES. No runtime imports beyond standard libs. Per
 * the project's no-defensive-programming rule, callers must pattern-
 * match on the discriminator — no isXxx() guards, no field-presence
 * probes.
 *
 * Promoted from v2/types.ts in PR 13. PipelineResultV2/PipelineTraceV2
 * are now the canonical PipelineResult/PipelineTrace.
 */

// ---------------------------------------------------------------------------
// Imports from the legacy types we deliberately keep (the 80%).
// ---------------------------------------------------------------------------

import type {
  CanonicalLineItem,
} from '../operators/operator-config.types.js';
import type {
  MerchantCodeState,
  ParsedItem,
  SanityResult,
  SanityVerdict,
  StageTrace,
  ClassificationStatus,
} from './shared/pipeline.types.js';

// Re-exports for convenience — callers import from a single surface.
export type {
  CanonicalLineItem,
  MerchantCodeState,
  ParsedItem,
  SanityResult,
  SanityVerdict,
  StageTrace,
  ClassificationStatus,
};

// ---------------------------------------------------------------------------
// Stage 1 — Parse (kept from current; ParseOutcome union restated here
// so the v2 pipeline doesn't import from the legacy parse module's own
// type names that we may rename later).
// ---------------------------------------------------------------------------

export type ParseReject = {
  rejected: true;
  /**
   * Why parse rejected the row:
   * - `no_description`: description is null / empty / whitespace only.
   * - `digit_only_description`: description contains digits only (no
   *   letters in any script). Such rows cannot identify a product —
   *   they're upload-glitch placeholders or invoice numbers leaking
   *   into the description column. Operator clarification needed.
   */
  reason: 'no_description' | 'digit_only_description';
};
export type ParseAccept = { rejected: false; item: ParsedItem };
export type ParseOutcome = ParseReject | ParseAccept;

// ---------------------------------------------------------------------------
// Stage 2 — Identify (split into fast + optional web fallback).
//
// The pipeline runs identify_fast first (Sonnet, NO web_search tool).
// When kind === 'uninformative' && cause === 'genuine' OR kind ===
// 'multi_product', the orchestrator follows up with identify_web
// (Sonnet + web_search). identify_web's result REPLACES the fast result
// for downstream stages — they're not merged.
//
// Per Q1+Q2 decisions (2026-05-15):
//   - Both passes use Sonnet (LLM_MODEL_STRONG), not Haiku.
//   - Web fallback fires ONLY on the two predicate kinds above; low-
//     confidence clean_product is NOT a trigger (confidence is
//     uncalibrated; gating on it would over-fire).
// ---------------------------------------------------------------------------

/** Which identify pass produced the result. Always present on traces. */
export type IdentifyPass = 'fast' | 'web';

/**
 * Cause discriminator on uninformative outcomes. Mirrors what the legacy
 * anchored pipeline used so persisted traces remain readable.
 */
export type IdentifyCause =
  | 'genuine' // model decided in good faith it can't identify
  | 'transport' // LLM transport error (429, timeout, network)
  | 'parse' // LLM produced output that wouldn't parse
  | 'short_circuit' // empty input or other upstream short-circuit
  | 'contract'; // LLM produced a structurally-invalid value

/**
 * Per-call audit metadata. Every variant of IdentifyResult carries one
 * of these so downstream stages have uniform observability.
 */
export interface IdentifyCallTrace {
  pass: IdentifyPass;
  llm_called: boolean;
  latency_ms: number;
  model: string | null;
  status: 'ok' | 'skipped' | 'error' | 'timeout' | 'parse';
  web_search_used: boolean;
  /** Cross-check: model's self-reported evidence vs. actual tool use. */
  evidence_mismatch: boolean;
}

export interface IdentifyClean {
  kind: 'clean_product';
  /** Tariff-English noun, 4-18 words. Brand-stripped. */
  canonical: string;
  /** 2-digit HS chapter, null when the model can't commit (composite goods). */
  family_chapter: string | null;
  /** Lexical anchors for retrieval (brand, ingredient, model code). */
  identity_tokens: string[];
  /** Self-rated 0.0-1.0. NOT calibrated. */
  confidence: number;
  evidence: 'world_knowledge' | 'web';
  /**
   * Brand-only rescue path (identify_web). When the input was a
   * brand name with no product noun, the model commits to the
   * flagship product line at low confidence and lists the brand's
   * other product lines here so the UI / HITL reviewer can see the
   * alternatives at a glance. Empty / undefined for description-based
   * identifies (the normal case).
   */
  brand_alternatives?: string[];
  trace: IdentifyCallTrace;
}

export interface IdentifyMulti {
  kind: 'multi_product';
  /** >= 2 entries when emitted by the model. */
  products: string[];
  trace: IdentifyCallTrace;
}

export interface IdentifyUninformative {
  kind: 'uninformative';
  cause: IdentifyCause;
  /** Short human-readable reason, capped ~200 chars. */
  reason: string;
  trace: IdentifyCallTrace;
}

export type IdentifyResult =
  | IdentifyClean
  | IdentifyMulti
  | IdentifyUninformative;

// ---------------------------------------------------------------------------
// Stage 3 — Merchant resolution (renamed from constrain.resolution).
//
// Pure deterministic codebook walk: validate the merchant code, expand
// short prefixes by walking down the HS tree, apply per-operator
// override table, swap deprecated codes for replacements. May fire 0-2
// LLM calls (multi-replacement disambiguation, prefix-walk leaf pick).
//
// Identical state-set to the current anchored constrain.resolution.
// ---------------------------------------------------------------------------

export type MerchantResolution =
  /** No merchant code on this row. */
  | { state: 'absent' }
  /** Code couldn't be parsed (wrong length, non-numeric prefix). */
  | { state: 'malformed'; source_code: string }
  /** 12-digit code, active in the codebook, used verbatim. */
  | { state: 'active'; resolved_code: string }
  /** Deprecated 12-digit code with exactly one replacement; deterministic swap. */
  | {
      state: 'replaced_single';
      resolved_code: string;
      source_code: string;
    }
  /** Operator override matched; resolved_code is the override target. */
  | {
      state: 'override_applied';
      resolved_code: string;
      source_code: string;
      override_matched_length: number;
    }
  /** Deprecated 12-digit, multi-replacement, LLM picked one. */
  | {
      state: 'llm_picked_replacement';
      resolved_code: string;
      source_code: string;
      candidates: string[];
    }
  /** 6-11 digit prefix expanded by walking down the codebook. */
  | {
      state: 'expanded_prefix';
      resolved_code: string;
      valid_prefix: string;
      source_code: string;
    }
  /** Walk failed; cause discriminates the failure mode. */
  | {
      state: 'unknown';
      source_code: string;
      cause:
        | 'not_in_codebook'
        | 'no_replacements'
        | 'llm_pick_failed_replacement'
        | 'prefix_empty'
        | 'llm_pick_failed_prefix';
      matched_prefix: string | null;
    };

export interface MerchantResolutionTrace {
  llm_called: boolean;
  latency_ms: number;
  override_attempted: boolean;
  override_matched: boolean;
}

// ---------------------------------------------------------------------------
// Stage 4 — Scope selection.
//
// Pure deterministic function:
//   selectScopes(identify, merchant_resolution): ScopeSelection
//
// Outputs the primary retrieval arm + zero or more secondary arms +
// audit flags. The orchestrator hands ScopeSelection to multi-arm
// retrieval, which fires each arm in parallel.
//
// Rules summary (per the rewrite plan):
//   - merchant resolved + identify clean_product, chapters disagree
//     above 0.85 confidence → add identify-side family_chapter as
//     secondary; audit_flag=merchant_chapter_disagreement.
//   - merchant resolved + identify clean_product, family_chapter null
//     (composite goods) → add unconstrained as secondary; audit_flag=
//     identify_family_null.
//   - identify.identity_tokens.length > 0 → add lexical_tokens arm.
//   - merchant_resolution.state === 'override_applied' → suppress all
//     secondaries; audit_flag=override_suppresses_secondary.
//   - multi_product or uninformative+no-merchant → primary kind is
//     'escalate', orchestrator short-circuits.
// ---------------------------------------------------------------------------

export type RetrievalArm =
  | {
      kind: 'merchant_prefix';
      prefix: string;
      source:
        | 'merchant_active'
        | 'merchant_expanded'
        | 'merchant_replacement_picked'
        | 'override_applied';
    }
  | {
      kind: 'family_chapter';
      chapter: string;
      source: 'identify';
    }
  | {
      kind: 'unconstrained';
      reason:
        | 'composite_product'
        | 'no_merchant_low_confidence_identify'
        | 'identify_uninformative_merchant_only';
    }
  | {
      kind: 'lexical_tokens';
      tokens: string[];
    }
  | {
      kind: 'escalate';
      reason:
        | 'identify_multi_product'
        | 'identify_uninformative_no_merchant'
        | 'merchant_malformed_no_family';
    };

export type ScopeAuditFlag =
  | 'merchant_chapter_disagreement'
  | 'override_suppresses_secondary'
  | 'identify_family_null';

export interface ScopeSelection {
  primary: RetrievalArm;
  /** Zero or more additional arms run in parallel with primary. */
  secondaries: RetrievalArm[];
  audit_flags: ScopeAuditFlag[];
}

// ---------------------------------------------------------------------------
// Stage 5 — Retrieval + union.
//
// Each arm calls retrieveCandidates() against the shared retrieval
// engine. Results are unioned (dedupe by code, keep highest rrf_score)
// and tagged with the source arm. The reranker downstream re-orders
// this set.
// ---------------------------------------------------------------------------

export interface ScoredCandidate {
  code: string; // 12-digit HS leaf
  description_en: string | null;
  description_ar: string | null;
  /**
   * Full breadcrumb path from chapter to leaf, joined by " > "
   * (e.g. "Electrical machines and apparatus... > Other machines... > Laser hair removal").
   * Source: zatca_hs_code_display.path_en. Empty string when the
   * display row is missing (defensive — should never happen post-ingest).
   * Threaded through retrieval -> rerank -> picker so each annotated
   * candidate on the wire can show the full path, not just the leaf label.
   */
  path_en: string;
  /** Same shape as path_en, in Arabic ("، " separator). Empty string if missing. */
  path_ar: string;
  rrf_score: number;
  bm25_score: number | null;
  vector_score: number | null;
  trigram_score: number | null;
  source_arm:
    | 'merchant_prefix'
    | 'family_chapter'
    | 'unconstrained'
    | 'lexical_tokens';
}

// ---------------------------------------------------------------------------
// Stage 6 — Reranker (deterministic v1, 6 cheap features).
//
// Cap = 8 (per Q4 decision 2026-05-15: tighter than v1's original 8-12
// to honor the p50 latency target ≤ 15s).
// ---------------------------------------------------------------------------

export interface RerankFeatures {
  rrf_score: number;
  chapter_agreement: boolean;
  identity_token_overlap_count: number;
  /** -0.10 to +0.10 based on source arm and merchant resolution authority. */
  arm_boost: number;
}

export interface RerankedCandidate extends ScoredCandidate {
  rerank_score: number;
  rerank_features: RerankFeatures;
}

// ---------------------------------------------------------------------------
// Stage 7 — Picker (single LLM call, multi-arm aware).
//
// PickResult is a discriminated union; downstream stages branch on
// pick.kind. picked_from_arm tells operators which retrieval arm
// surfaced the winning candidate (audit-grade signal).
// ---------------------------------------------------------------------------

export interface PickCallTrace {
  llm_called: boolean;
  latency_ms: number;
  model: string | null;
  status: 'ok' | 'skipped' | 'error' | 'timeout' | 'parse';
  candidate_count: number;
  audit_flag: boolean;
}

/**
 * Per-candidate row carried on the wire so the SPA can render
 * "Considered alternatives" and the HITL reviewer can see the picker's
 * verdict per row. One per candidate the picker actually evaluated
 * (top N after rerank, N=8 today).
 *
 * `fit` and `rationale` come from the picker's LLM response; everything
 * else is metadata the retrieval pipeline already had in memory
 * (descriptions + per-arm provenance + rerank score). Free-text
 * `rationale` is truncated to 300 chars before serialisation to keep
 * payload size predictable; the full text stays in the picker's logs.
 */
export interface AnnotatedCandidate {
  code: string;
  description_en: string | null;
  description_ar: string | null;
  /**
   * Full breadcrumb path en/ar (e.g. "Electrical machines... > Laser
   * hair removal"). Sourced from zatca_hs_code_display.path_en. Lets
   * the SPA show context, not just the leaf label.
   */
  path_en: string;
  path_ar: string;
  fit: 'fits' | 'partial' | 'does_not_fit';
  /**
   * Computed confidence for THIS candidate, treating it as if it were
   * the picker's pick. Same formula as the winner's confidence
   * (computeConfidence in pick.ts). Lets reviewers compare candidates
   * on a continuous axis. The winner's confidence on the response
   * envelope (classification_result.classification_confidence) equals
   * the confidence on the candidate whose code matches final_code.
   */
  confidence: number;
  /** Picker's per-candidate rationale, max 300 chars. */
  rationale: string;
  /** Which retrieval arm surfaced this candidate. */
  source_arm:
    | 'merchant_prefix'
    | 'family_chapter'
    | 'unconstrained'
    | 'lexical_tokens';
  /** Deterministic rerank score (RRF-derived, post-boosts). */
  rerank_score: number;
}

/**
 * Per-row breakdown that produced the picker confidence number. All
 * signals are deterministic — computed from trace fields the picker
 * already emits — so a reviewer can recompute and audit any value.
 * See computeConfidence() in pick.ts for the formula.
 */
export interface ConfidenceSignals {
  /** Base value from the picker's qualitative fit verdict. */
  base: number;
  /**
   * Cleaner pools earn a bonus: one unambiguous `fits` with no `partial`
   * competitors is worth more than a `fits` won out of 4-way ambiguity.
   */
  pool_cleanness_bonus: number;
  /**
   * Independent arms agreeing on the same chapter is strong evidence;
   * disagreement is a penalty.
   */
  arm_agreement_bonus: number;
  /**
   * Rerank-score gap between the #1 candidate and the #2 candidate.
   * A pulled-away winner is more trustworthy than a bunched leaderboard.
   * Relative gap = (s1 - s2) / s1; bonus is small but real.
   */
  rerank_gap_bonus: number;
  /** Clamp applied: `final = clamp(0.05, 0.99, base + bonuses)`. */
  raw_total: number;
}

export interface PickAccepted {
  kind: 'accepted';
  final_code: string; // 12-digit
  fit: 'fits' | 'partial';
  /**
   * Confidence in [0.05, 0.99] computed from trace signals — NOT an
   * LLM-emitted number. See ConfidenceSignals and computeConfidence().
   * The 3-tier constant {0.85 / 0.55 / 0.40} approach was retired in
   * migration 0082 era so two `fits` rows of very different quality
   * (1 winner vs 4-way ambiguity, cross-arm agreement vs disagreement,
   * separated rerank winner vs bunched scores) no longer collapse to
   * the same number.
   */
  confidence: number;
  /** Breakdown of the four signals that produced `confidence`. */
  confidence_signals: ConfidenceSignals;
  /** "GIR 1", "GIR 3(a)", "GIR 3(b)", "GIR 6", etc. */
  gir_applied: string;
  /** Counts across the candidates the picker evaluated. */
  verdict_population: {
    fits: number;
    partial: number;
    does_not_fit: number;
  };
  /** Which arm surfaced the winning candidate. */
  picked_from_arm:
    | 'merchant_prefix'
    | 'family_chapter'
    | 'unconstrained'
    | 'lexical_tokens';
  /** True iff first-2 of final_code !== first-2 of merchant code (when present). */
  merchant_chapter_disagreement: boolean;
  /**
   * Decomposed chapter-agreement signals (added 2026-05-19, PR3 / TASKS S2 #16
   * + plan §1.2.2). Each is the chapter-pairwise match. NULL components
   * collapse the pair to `null` (cannot compute). All four are computable
   * from existing data at write time — pure decomposition for downstream
   * rerank / verifier / SPA consumers that need the disaggregated view.
   */
  chapter_matches: {
    /** identify.family_chapter === final_code[:2]. NULL when identify isn't clean_product or family_chapter is null. */
    identify_and_pick: boolean | null;
    /** merchant_chapter === final_code[:2]. NULL when merchant_chapter is null. */
    merchant_and_pick: boolean | null;
    /** identify.family_chapter === merchant_chapter. NULL when either component is null. */
    identify_and_merchant: boolean | null;
    /** All three agree (identify, merchant, and pick on the same chapter). NULL when any input is null. */
    all_three: boolean | null;
  };
  candidate_count_by_arm: Record<string, number>;
  /**
   * Per-candidate verdicts the picker emitted (top N=8 reranked). The
   * UI uses this to render "Considered alternatives" and HITL reviewers
   * use it to second-guess the picker's choice. Includes the winning
   * candidate (callers should filter by `code !== final_code` when
   * rendering "alternatives").
   */
  annotated_candidates: AnnotatedCandidate[];
  trace: PickCallTrace;
}

export type PickEscalateReason =
  | 'scope_escalate'
  | 'no_candidates'
  | 'no_candidate_fits'
  | 'identify_no_query'
  | 'picker_unavailable';

export interface PickEscalate {
  kind: 'escalate';
  reason: PickEscalateReason;
  detail: string;
  /**
   * Per-candidate verdicts when the picker actually ran but couldn't
   * commit (e.g. all `does_not_fit`). Empty array when the escalate
   * happened before the LLM call (scope_escalate, identify_no_query,
   * no_candidates, picker_unavailable). HITL reviewers use this to see
   * what the picker rejected and pick manually.
   */
  annotated_candidates: AnnotatedCandidate[];
  trace: PickCallTrace;
}

export type PickResult = PickAccepted | PickEscalate;

// ---------------------------------------------------------------------------
// Stage 8 — Verifier (deterministic, no LLM).
//
// Two rules per Q4 decision 2026-05-15:
//   1. identify high-confidence (≥0.90) family_chapter disagrees with
//      picker's final_code chapter → trigger.
//   2. confidence inversion (picker partial ≤0.55 AND identify ≥0.92).
//
// Output routes the row:
//   PASS       → accept (current ACCEPT/FLAG-by-sanity behavior)
//   UNCERTAIN  → flag for operator review (separate queue from sanity_flag)
//
// Verifier NEVER overrides pick.final_code. Routing only.
// ---------------------------------------------------------------------------

export type VerifierRuleId =
  | 'identify_chapter_disagreement'
  | 'confidence_inversion';

export interface VerifierResult {
  result: 'PASS' | 'UNCERTAIN';
  rules_triggered: VerifierRuleId[];
}

// ---------------------------------------------------------------------------
// Submission + sanity (kept; parallelized at the orchestrator level).
//
// SubmissionDescriptionResult and SanityResult themselves are unchanged
// from current — those modules survive the rewrite. Imported from the
// shared types file at the top of this module.
// ---------------------------------------------------------------------------

export type SubmissionInvoked =
  | 'llm'
  | 'llm_failed'
  | 'fallback'
  | 'fallback_after_collision';

export interface SubmissionDescriptionResult {
  invoked: SubmissionInvoked;
  descriptionAr: string;
  latencyMs: number;
  model?: string | undefined;
  attempts: number;
  retried_reasons?: string[];
}

// ---------------------------------------------------------------------------
// Per-row pipeline trace.
//
// Replaces the legacy track_a/track_b/verdict shape AND the anchored
// anchored_identify/anchored_constrain/anchored_pick shape. Single
// canonical layout going forward.
// ---------------------------------------------------------------------------

export interface PipelineTrace {
  /**
   * Parse-stage classification of the merchant-supplied code. Carries
   * the original length bucket (twelve_digit / short_prefix / malformed
   * / absent) for downstream wire-format reporting. Independent of
   * merchant_resolution.state — a `short_prefix` parse can resolve to
   * an `expanded_prefix` or `unknown` resolution, but the parse
   * classification stays as-is.
   */
  parse: {
    merchant_code_state: MerchantCodeState;
  };
  identify: IdentifyResult;
  merchant_resolution: {
    resolution: MerchantResolution;
    trace: MerchantResolutionTrace;
  };
  scope: ScopeSelection;
  retrieval: {
    primary_candidate_count: number;
    secondary_candidate_counts: Record<string, number>;
    candidates_before_rerank: number;
    candidates_after_rerank: number;
    /**
     * PR4 (TASKS S2 #16 / plan §1.2.1): per-stage retrieval telemetry.
     * Lets downstream debugging attribute misclassifications to
     * retrieval vs. rerank vs. pick.
     */
    arms_fired?: string[];
    arms_zero_result_count?: number;
    /**
     * Query metadata (PR4 / plan §1.2.3). Helps attribute retrieval
     * failures to tokenization mismatch. Optional — not all paths
     * compute it (escalate paths don't construct a query).
     */
    query_token_count?: number;
    query_detected_language?: 'en' | 'ar' | 'fr' | 'unknown';
    query_is_brand_only?: boolean;
    /**
     * Which arm first surfaced the picked code:
     *   merchant_prefix / family_chapter / unconstrained / lexical_tokens
     *   / not_in_pool — the picked code was rescued by the picker via
     *     constrained generation (this should never happen in v2 because
     *     the picker is constrained to candidates, but kept as a
     *     sentinel for paranoia / future relaxations).
     * NULL when the pipeline didn't pick a code (escalate paths).
     */
    picked_code_recall_source?:
      | 'merchant_prefix'
      | 'family_chapter'
      | 'unconstrained'
      | 'lexical_tokens'
      | 'not_in_pool'
      | null;
  };
  pick: PickResult;
  verify: VerifierResult | null; // null when pick.kind === 'escalate'
  sanity: SanityResult | null;
  stages: StageTrace[];
}

// ---------------------------------------------------------------------------
// HITL routing reasons (kept from legacy, extended for verifier).
// ---------------------------------------------------------------------------

export type HitlReason =
  | 'verdict_escalate'
  | 'sanity_flag'
  | 'low_information'
  | 'verifier_uncertain'; // NEW for the v2 verifier UNCERTAIN routing

export interface HitlIntent {
  reason: HitlReason;
  cleaned_description: string;
}

// ---------------------------------------------------------------------------
// Final pipeline result (the orchestrator's return type).
// ---------------------------------------------------------------------------

export interface PipelineResult {
  final_code: string | null;
  goods_description_ar: string | null;
  sanity_verdict: SanityVerdict | null;
  classification_status: ClassificationStatus | null;
  hitl: HitlIntent | null;
  trace: PipelineTrace;
  infra_degraded: boolean;
}

// Backward-compat aliases. Callers that haven't been updated yet can still
// import these; remove after all consumers use the canonical names.
export type PipelineResultV2 = PipelineResult;
export type PipelineTraceV2 = PipelineTrace;
