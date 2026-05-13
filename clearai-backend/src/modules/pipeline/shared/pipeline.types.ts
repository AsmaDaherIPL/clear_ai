/**
 * Shared pipeline types — the contracts that flow between stages.
 * Every stage imports from here, not from each other's internals.
 */

// ---------------------------------------------------------------------------
// Stage 0a — Parse
// ---------------------------------------------------------------------------

export type MerchantCodeState =
  | 'twelve_digit'      // 12 numeric digits — may be active, deprecated, or unknown
  | 'short_prefix'      // 6, 8, or 10 digits — valid prefix, needs expansion
  | 'malformed'         // non-numeric, wrong length (anything not in {6,8,10,12})
  | 'absent';           // null / empty / whitespace only

export interface ParsedItem {
  /**
   * Digits-only merchant code (non-digits stripped). Null if absent or malformed.
   * Trailing zeros are SEMANTIC and preserved verbatim — `851830000000` and
   * `851830` are different claims with different downstream consequences. The
   * parser does NOT pad to a longer boundary; non-{6,8,10,12} lengths are
   * `malformed`.
   */
  raw_merchant_code: string | null;
  merchant_code_state: MerchantCodeState;
  /** Raw description as supplied. Null triggers immediate rejection. */
  raw_description: string | null;
  /** ASIN / EAN / GTIN extracted from description via regex. */
  identifiers: { type: 'asin' | 'ean' | 'gtin'; value: string }[];
  /** ISO 4217 currency code if present in the line item. */
  currency_code: string | null;
  /** Declared value in the stated currency. */
  value_amount: number | null;
}

// ---------------------------------------------------------------------------
// Stage 0b — Cleanup
// ---------------------------------------------------------------------------

export type ClarityVerdict = 'clear' | 'needs_research' | 'unusable';

export interface CleanupResult {
  cleaned_description: string;
  language: string;
  tokens: string[];
  clarity_verdict: ClarityVerdict;
  /** Raw description passed through when LLM degraded. */
  degraded: boolean;
  latency_ms: number;
  /**
   * Tariff-vocabulary English re-expression — only populated when the
   * input is non-English. Empty string for English input or when the
   * LLM declined to produce one. Track A retrieval prefers this over
   * `cleaned_description` when present, because the catalog speaks
   * tariff English natively. See description-cleanup.md prompt.
   */
  tariff_expansion_en: string;
  /** Total LLM attempts including the first call. 0 when short-circuited. */
  attempts: number;
  /** Reason recorded for each attempt that triggered a parse retry. */
  retried_reasons: string[];
}

// ---------------------------------------------------------------------------
// Track A — Description classifier output
// ---------------------------------------------------------------------------

/** Fit verdict assigned by the description classifier to each retrieval candidate. */
export type CandidateFitVerdict = 'fits' | 'partial' | 'does_not_fit';

/** Retrieval candidate annotated with a relevance verdict by the description classifier. */
export interface AnnotatedCandidate {
  code: string;
  description_en: string | null;
  description_ar: string | null;
  rrf_score: number;
  fit: CandidateFitVerdict;
  rationale: string;
}

/** Researcher detail surfaced in the trace. */
export interface DescriptionClassifierResearchDetail {
  source: 'cheap_llm' | 'web_search' | 'failed_passthrough';
  recognised: boolean;
  enriched_description: string;
  unrecognised_reason: string | null;
  evidence_quote: string | null;
  model: string | null;
  latency_ms: number;
  /** Total attempts including the first call (>=1). */
  attempts: number;
  /** Reason recorded for each attempt that triggered a parse retry. */
  retried_reasons?: string[];
}

export interface DescriptionClassifierResult {
  /**
   * Retrieval candidates annotated with fit verdicts by the description classifier.
   * Ordered by retrieval score. Empty when threshold failed or retrieval returned nothing.
   * Reconciliation uses this list as its primary description-side evidence.
   */
  annotated_candidates: AnnotatedCandidate[];
  /** True when retrieval threshold failed (uninformative candidates). */
  threshold_failed: boolean;
  /** True when all candidates were verdicted does_not_fit. */
  no_fit: boolean;
  interpretation_stage: 'passthrough' | 'cleaned' | 'researched';
  effective_description: string;
  research: DescriptionClassifierResearchDetail | null;
  web_research: DescriptionClassifierResearchDetail | null;
  /**
   * Chapters inferred from keyword signals in the effective description.
   * Empty when no keywords matched. Used by reconciliation to detect cases
   * where the merchant code agrees with the description's inferred chapter
   * but Track A's picker landed in a different chapter (the Geomag case).
   */
  inferred_chapters: string[];
  /**
   * True when chapter-coherence filter aborted because filtering would
   * have dropped below MIN_CANDIDATES. Means retrieval didn't surface
   * candidates in the inferred chapters — a strong signal that Track A's
   * picker results may be drifting away from the merchant's intent.
   */
  prefilter_aborted: boolean;
}

// ---------------------------------------------------------------------------
// Track B — Code resolver output
// ---------------------------------------------------------------------------

/**
 * How the codebook resolved the input that was actually walked. When a
 * tenant override fired, the input to this walk is the override's target
 * code, not the raw merchant code — `override_applied` and
 * `override_target_code` on CodeResolverResult tell you whether and to what
 * the override translated. There is no `tenant_override` enum value
 * because override is no longer a terminal stop.
 */
export type TrackBResolution =
  | 'passthrough'                    // 12-digit, active in codebook
  | 'deterministic_swap'             // deprecated, single replacement
  | 'llm_pick_among_replacements'    // deprecated, multiple replacements, LLM picked
  | 'llm_pick_under_prefix'          // short prefix expanded, LLM picked leaf
  | 'null_resolution';               // absent / malformed / codebook miss

export type CodebookState =
  | 'active'
  | 'deprecated_single_replacement'
  | 'deprecated_multiple_replacements'
  | 'unknown_to_codebook'
  | 'not_applicable';                // merchant code was absent

export interface TrackBLlmContext {
  chosen: { code: string; rationale: string };
  runners_up: Array<{ code: string; rationale: string }>;
}

/**
 * Verdict from the description-anchored subtree retrieval (PR 5).
 *
 * consistent      — top reranker candidate's prefix matches valid_prefix AND
 *                   its fit-verdict is `fits`. Description positively confirms
 *                   the merchant's heading.
 * ambiguous       — top reranker candidate's prefix matches valid_prefix but
 *                   the description does NOT positively confirm the heading
 *                   (top fit is `partial`, OR description is silent on
 *                   dimensions the leaf constrains). Reconciliation should
 *                   resolve as AMBIGUOUS_MATERIAL conflict, not silently
 *                   accept the merchant code.
 * contradicts     — top reranker candidate's prefix does NOT start with
 *                   valid_prefix. Hard violation: the description pulls
 *                   strongly toward a different chapter. Reconciliation
 *                   resolves as CONTRADICTION (collapsed to classification
 *                   _status=DRIFT in the V1 external surface); merchant
 *                   code overridden.
 * not_applicable  — no valid prefix to anchor to (merchant code absent or
 *                   malformed, or codebook walk produced no resolvable input).
 *                   Subtree retrieval did not run.
 */
export type ConsistencyVerdict = 'consistent' | 'ambiguous' | 'contradicts' | 'not_applicable';

/** Subtree retrieval candidate annotated with a relevance verdict (PR 5). */
export interface SubtreeAnnotatedCandidate {
  code: string;
  description_en: string | null;
  description_ar: string | null;
  rrf_score: number;
  fit: CandidateFitVerdict;
  rationale: string;
}

export interface CodeResolverResult {
  /** Resolved 12-digit code. Null when resolution='null_resolution'. */
  resolved_code: string | null;
  resolution: TrackBResolution;
  raw_merchant_code: string | null;
  codebook_state: CodebookState;
  /** True when a tenant override matched the merchant code and its target was fed into the codebook walk. */
  override_applied: boolean;
  /** The code the override mapped to before the codebook walk. Null when no override fired. */
  override_target_code: string | null;
  /** Present only for llm_pick_among_replacements and llm_pick_under_prefix. */
  llm_context?: TrackBLlmContext;
  /**
   * PR 5: description-anchored subtree retrieval verdict. Computed in parallel
   * with the codebook walk above. `not_applicable` when no valid prefix to
   * anchor to. Trace-only field — not surfaced as a top-level
   * classification_events column until operational filtering proves useful.
   */
  consistency_verdict: ConsistencyVerdict;
  /**
   * The HS prefix (heading-level, 6 digits) the subtree retrieval anchored to.
   * Derived from the merchant's claimed code. Null when consistency_verdict =
   * not_applicable.
   */
  valid_prefix: string | null;
  /**
   * Subtree retrieval candidates (top 5) with per-candidate fit verdicts.
   * Empty when consistency_verdict = not_applicable. Reconciliation reads this
   * to decide AGREEMENT / AMBIGUOUS_MATERIAL / CONTRADICTION conflict types.
   * When consistency_verdict = contradicts, the top candidate is from the
   * unconstrained reranker output (forced through the prefix violation).
   */
  subtree_candidates: SubtreeAnnotatedCandidate[];
}

// ---------------------------------------------------------------------------
// Stage 2 — Verdict / Reconciliation
// ---------------------------------------------------------------------------

/**
 * Internal-only enum used by reconciliation control flow. NOT surfaced in
 * the trace output — consumers should derive it (or whatever they actually
 * need) from `description_classifier_chosen_code` / `code_resolver_resolved_code`
 * being non-null.
 */
export type SignalCount = 'two_signal' | 'single_a' | 'single_b' | 'zero';

export type ReconciliationSource = 'description_classifier' | 'code_resolver' | 'reconciled';

export type VerdictDecision = 'accept' | 'escalate';

/**
 * V1 external classification status. Three values, surfaced to the UI / API
 * consumers as the single answer to "did the two tracks agree on the code?":
 *
 *   AGREEMENT    — both tracks agree (or one carries the row uncontested)
 *                  → accept, ship to ZATCA
 *   DRIFT        — tracks disagree on the code but we have an answer
 *                  → accept, ship to ZATCA (operator can review post-flight)
 *   ZERO_SIGNAL  — neither track has a defensible code
 *                  → escalate to HITL before any submission
 *
 * Replaces the six-way internal conflict-type taxonomy at the external
 * surface. The internal precedence (AGREEMENT > CONTRADICTION > DRIFT >
 * AMBIGUOUS > SPARSE > ZERO_SIGNAL) is preserved by the classifier for
 * accuracy reasons — the collapse to three values only happens at the
 * VerdictResult boundary, so the right code still wins under each input
 * shape.
 *
 * Defined here so both the classifier and the trace bundlers (dispatch-v1,
 * classification_events) speak the same vocabulary.
 */
export type ClassificationStatus = 'AGREEMENT' | 'DRIFT' | 'ZERO_SIGNAL';

/**
 * Internal forensic field — kept in the verdict + classification_events
 * trace JSON for debugging, but not surfaced on any API response. New
 * callers should pattern-match on ClassificationStatus instead.
 *
 * `AMBIGUOUS_MATERIAL` and `SPARSE_DESCRIPTION` are themselves @deprecated
 * within ConflictType. The classifier now emits `AMBIGUOUS` in their stead
 * (both had identical handler behavior). The two stale literals are kept
 * in the union ONLY so historical trace JSON parsed back into TypeScript
 * still typechecks. New code never emits them.
 */
export type ConflictType =
  | 'AGREEMENT'
  | 'DRIFT'
  | 'AMBIGUOUS'
  | 'CONTRADICTION'
  | 'ZERO_SIGNAL'
  /** @deprecated Collapsed into AMBIGUOUS. Kept for historical trace JSON typechecking. */
  | 'AMBIGUOUS_MATERIAL'
  /** @deprecated Collapsed into AMBIGUOUS. Kept for historical trace JSON typechecking. */
  | 'SPARSE_DESCRIPTION';

/** Map V1 ClassificationStatus from the internal ConflictType. */
export function classificationStatusFromConflictType(c: ConflictType): ClassificationStatus {
  if (c === 'AGREEMENT') return 'AGREEMENT';
  if (c === 'ZERO_SIGNAL') return 'ZERO_SIGNAL';
  // DRIFT, AMBIGUOUS, CONTRADICTION (+ deprecated AMBIGUOUS_MATERIAL /
  // SPARSE_DESCRIPTION for legacy trace JSON) → DRIFT
  // Justification:
  //   DRIFT          — leaf dispute under shared heading, ship
  //   AMBIGUOUS      — description silent or thin; merchant heading carries
  //                    (collapses the legacy AMBIGUOUS_MATERIAL + SPARSE_DESCRIPTION)
  //   CONTRADICTION  — Track A rank-1 overrides merchant heading
  // From the operator's perspective these are all "we picked a code, but the
  // tracks disagreed somewhere along the way." The forensic distinction stays
  // in the trace JSON's conflict_type field for engineers debugging.
  return 'DRIFT';
}

export interface VerdictResult {
  decision: 'accept';
  final_code: string;
  rationale: string;
  source: ReconciliationSource;
  /**
   * V1 external surface. Three values: AGREEMENT, DRIFT, ZERO_SIGNAL.
   * Derived deterministically from `conflict_type` via
   * `classificationStatusFromConflictType()`. Always present on accept.
   * ZERO_SIGNAL never appears here — that conflict type escalates instead
   * (see VerdictEscalate.classification_status).
   */
  classification_status: ClassificationStatus;
  /**
   * Internal forensic field — surfaced only in trace JSON for debugging.
   * The external surface is `classification_status`. Never appears on
   * API responses.
   */
  conflict_type: ConflictType;
}

export interface VerdictEscalate {
  decision: 'escalate';
  disagreement_summary: string;
  /** V1 external surface: always ZERO_SIGNAL on the escalate path. */
  classification_status: 'ZERO_SIGNAL';
  /** Internal forensic field, same as VerdictResult.conflict_type. */
  conflict_type: 'ZERO_SIGNAL';
}

export type StageVerdictOutput = VerdictResult | VerdictEscalate;

// ---------------------------------------------------------------------------
// Stage 3 — Sanity
// ---------------------------------------------------------------------------

/**
 * What the sanity LLM is allowed to return. Value-plausibility only —
 * the code is already decided by Stage 2; sanity does NOT re-litigate it.
 * BLOCK is intentionally absent: the LLM cannot reject a classification
 * the rest of the pipeline accepted. FLAG routes to HITL with the code
 * intact.
 */
export type SanityLlmVerdict = 'PASS' | 'FLAG';

/**
 * What the orchestrator emits as the overall pipeline outcome on
 * `PipelineResult.sanity_verdict`. Adds BLOCK for upstream pre-
 * classification rejections (parse failure, cleanup unusable) that the
 * orchestrator emits BEFORE the sanity stage ever runs. The LLM itself
 * is bounded to SanityLlmVerdict.
 */
export type SanityVerdict = SanityLlmVerdict | 'BLOCK';

export interface SanityResult {
  verdict: SanityLlmVerdict;
  rationale: string;
  latency_ms: number;
  /**
   * True when the sanity LLM exhausted retries and the stage degraded to PASS
   * rather than recording an actual plausibility judgement. Operators see
   * this in trace meta to distinguish a real PASS from a sanity-skipped row.
   */
  degraded?: boolean;
  /** Total LLM attempts including the first call (>=1). Omitted on skip. */
  attempts?: number;
  /** Reason recorded for each attempt that triggered a parse retry. */
  retried_reasons?: string[];
}

// ---------------------------------------------------------------------------
// Pipeline trace
// ---------------------------------------------------------------------------

export interface StageTrace {
  name: string;
  started_at: string;   // ISO-8601
  duration_ms: number;
  outcome: 'ok' | 'skipped' | 'failed';
  detail?: unknown;
}

export interface PipelineTrace {
  track_a: DescriptionClassifierResult | null;
  track_b: CodeResolverResult | null;
  verdict: StageVerdictOutput | null;
  sanity: SanityResult | null;
  stages: StageTrace[];
}

// ---------------------------------------------------------------------------
// Final pipeline output (consumed by declaration-runs/classification)
// ---------------------------------------------------------------------------

/**
 * HITL intent attached to PipelineResult when Stage 2 escalates or Stage 3
 * FLAGs. The orchestrator does NOT write the queue row directly — the
 * route handler does, after the classification_events row is persisted,
 * so the FK is always satisfied. Null when the item does not need review.
 */
/**
 * Why a row is in the HITL queue:
 *
 *   verdict_escalate  — reconciliation could not pick a defensible code
 *                       (ZERO_SIGNAL, or degenerate DRIFT).
 *   sanity_flag       — code was chosen but Stage 3 sanity flagged the
 *                       declared value as implausible.
 *   low_information   — researcher could not identify the product AND the
 *                       description is too thin to retrieve against. The
 *                       pipeline refuses to guess; the reviewer must
 *                       supply context (often by contacting the merchant).
 *                       Distinct from verdict_escalate because the
 *                       refusal happens BEFORE reconciliation, not after.
 */
export interface HitlIntent {
  reason: 'verdict_escalate' | 'sanity_flag' | 'low_information';
  cleaned_description: string;
}

export interface PipelineResult {
  /** 12-digit code accepted by Stage 2 + Stage 3. Null if pipeline did not accept. */
  final_code: string | null;
  /**
   * Arabic goods description sourced from zatca_hs_codes for the accepted code.
   * Present only when sanity_verdict is PASS or FLAG.
   */
  goods_description_ar: string | null;
  sanity_verdict: SanityVerdict;
  trace: PipelineTrace;
  /** Set when the item should be enqueued for HITL review. Null otherwise. */
  hitl: HitlIntent | null;
  /**
   * True when an LLM-backed stage exhausted its retry budget and degraded
   * (graceful_degrade) rather than producing a fresh judgement. Used by the
   * classification service to downgrade the resulting row status from
   * succeeded/flagged/failed to 'pending_infra' so the HITL queue can filter
   * infra-only failures separately from real bad-data rows.
   *
   * Never true for legitimate ZERO_SIGNAL escalations (low_information),
   * clean BLOCK, or healthy succeeded paths.
   */
  infra_degraded: boolean;
}

// ---------------------------------------------------------------------------
// dispatch-v1 — wire format for POST /pipeline/dispatch
// ---------------------------------------------------------------------------
//
// Vocabulary contract (three nesting levels, never overloaded):
//   stage   = top-level pipeline phase: normalize | classify | sanity
//   action  = inside stage.actions[]:   parse, cleanup, description_classifier,
//                                       code_resolver, reconciliation,
//                                       submission_description, sanity_check
//   step    = inside action.steps[]:    researcher, retrieval, threshold,
//                                       web_researcher, picker,
//                                       operator_override_lookup,
//                                       codebook_lookup
//
// PipelineTrace (the legacy in-process shape) is still used by Track A and
// the orchestrator while the algorithms run. The route handler converts it
// to DispatchV1Response at the wire boundary so the SPA/UI sees the cleaner
// shape without forcing a stage-by-stage refactor of the orchestrator.

export type DispatchV1Outcome = 'ok' | 'skipped' | 'failed' | 'failed_gate';

export type DispatchV1StageName = 'normalize' | 'classify' | 'sanity';

export type DispatchV1ActionName =
  | 'parse'
  | 'cleanup'
  | 'description_classifier'
  | 'code_resolver'
  | 'reconciliation'
  | 'submission_description'
  | 'sanity_check';

export type DispatchV1StepName =
  | 'researcher'
  | 'retrieval'
  | 'threshold'
  | 'web_researcher'
  | 'retrieval_after_web'
  | 'threshold_after_web'
  | 'picker'
  | 'operator_override_lookup'
  | 'codebook_lookup';

export interface DispatchV1Step {
  step: DispatchV1StepName;
  duration_ms: number;
  outcome: DispatchV1Outcome;
  model?: string;
  output?: Record<string, unknown>;
}

export interface DispatchV1Action {
  action: DispatchV1ActionName;
  duration_ms: number;
  outcome: DispatchV1Outcome;
  llm_used?: boolean;
  model?: string;
  /** True for code_resolver, false for description_classifier. Surfaces the architectural blindness invariant. */
  merchant_code_visible_to_model?: boolean;
  input?: Record<string, unknown>;
  steps?: DispatchV1Step[];
  output?: Record<string, unknown>;
}

export interface DispatchV1Stage {
  stage: DispatchV1StageName;
  started_at: string;
  duration_ms: number;
  outcome: DispatchV1Outcome;
  input?: Record<string, unknown>;
  actions: DispatchV1Action[];
  output?: Record<string, unknown>;
}

export interface DispatchV1Summary {
  merchant_code_state: MerchantCodeState | null;
  /** Highest-RRF candidate verdicted 'fits' by the description classifier. Null when none. */
  description_classifier_top_fit: string | null;
  code_resolver_code: string | null;
  reconciliation: 'description_classifier' | 'code_resolver' | 'reconciled' | 'escalated' | null;
  operator_override_applied: boolean;
  final_code: string | null;
  sanity_verdict: SanityVerdict | null;
}

export interface DispatchV1Trace {
  trace_version: 'dispatch-v1';
  started_at: string;
  completed_at: string;
  duration_ms: number;
  llm_calls_used: number;
  summary: DispatchV1Summary;
  stages: DispatchV1Stage[];
}

export interface DispatchV1Response {
  item_id: string;
  operator_slug: string;
  status: 'succeeded' | 'failed' | 'rejected';
  final_code: string | null;
  goods_description_ar: string | null;
  goods_description_en: string | null;
  sanity_verdict: SanityVerdict;
  trace: DispatchV1Trace;
}
