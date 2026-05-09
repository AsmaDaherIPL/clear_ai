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
  | 'malformed'         // non-numeric, wrong length, etc.
  | 'absent';           // null / empty / whitespace only

export interface ParsedItem {
  /** Digits-only merchant code (stripped). Null if absent or malformed. */
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
export interface TrackAResearchDetail {
  source: 'cheap_llm' | 'web_search' | 'failed_passthrough';
  recognised: boolean;
  enriched_description: string;
  unrecognised_reason: string | null;
  evidence_quote: string | null;
  model: string | null;
  latency_ms: number;
}

export interface TrackAResult {
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
  research: TrackAResearchDetail | null;
  web_research: TrackAResearchDetail | null;
}

// ---------------------------------------------------------------------------
// Track B — Code resolver output
// ---------------------------------------------------------------------------

/**
 * How the codebook resolved the input that was actually walked. When a
 * tenant override fired, the input to this walk is the override's target
 * code, not the raw merchant code — `override_applied` and
 * `override_target_code` on TrackBResult tell you whether and to what
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

export interface TrackBResult {
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
 * Named confidence tier emitted by reconciliation.
 *
 * certain  — both tracks independently agree (deterministic corroboration).
 * high     — strong single signal: resolver in partial-fit set, or description
 *            classifier produced a fits-level candidate with no resolver dispute.
 * medium   — LLM arbitration on two-signal disagreement, or single_a partial only.
 * low      — override-curated code passed through after reconciliation LLM failure.
 * none     — pipeline escalated; no code accepted.
 */
export type ConfidenceBand = 'certain' | 'high' | 'medium' | 'low' | 'none';

export interface VerdictResult {
  decision: 'accept';
  final_code: string;
  confidence_band: ConfidenceBand;
  rationale: string;
  source: ReconciliationSource;
}

export interface VerdictEscalate {
  decision: 'escalate';
  disagreement_summary: string;
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
  track_a: TrackAResult | null;
  track_b: TrackBResult | null;
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
export interface HitlIntent {
  reason: 'verdict_escalate' | 'sanity_flag';
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
