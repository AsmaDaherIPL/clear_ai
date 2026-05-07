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

/** Shape of the retrieval candidates surfaced in the trace. */
export interface TrackACandidate {
  code: string;
  description_en: string | null;
  description_ar: string | null;
  rrf_score: number;
}

/** Researcher detail surfaced in the trace. */
export interface TrackAResearchDetail {
  /** Stage at which the researcher fired. */
  source: 'cheap_llm' | 'web_search' | 'failed_passthrough';
  /** True when the researcher returned a canonical description. */
  recognised: boolean;
  /** What the researcher's enriched description was (the input to retrieval). */
  enriched_description: string;
  /** Reason / error string when not recognised. */
  unrecognised_reason: string | null;
  /** Web evidence quote (only set when source='web_search' and recognised). */
  evidence_quote: string | null;
  /** Model that produced the result. */
  model: string | null;
  latency_ms: number;
}

export interface TrackAResult {
  /** Null when threshold failed or Picker returned no_fit. */
  chosen_code: string | null;
  /** 0-1 confidence from Picker. Null when no code chosen. */
  confidence: number | null;
  rationale: string | null;
  alternatives: Array<{ code: string; rationale: string }>;
  /** True when retrieval threshold failed (uninformative candidates). */
  threshold_failed: boolean;
  /** True when Picker returned no_fit despite threshold passing. */
  no_fit: boolean;
  /** Stage the input reached before retrieval. */
  interpretation_stage: 'passthrough' | 'cleaned' | 'researched';
  /** Description fed into retrieval (post-cleanup, possibly post-researcher). */
  effective_description: string;
  /** Top retrieval candidates the picker saw, ordered by score. Empty when retrieval returned nothing. */
  candidates: TrackACandidate[];
  /** Researcher details — null when researcher didn't run. */
  research: TrackAResearchDetail | null;
  /** Web research details — null when web research didn't run. */
  web_research: TrackAResearchDetail | null;
}

// ---------------------------------------------------------------------------
// Track B — Code resolver output
// ---------------------------------------------------------------------------

export type TrackBResolution =
  | 'tenant_override'
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
  /** Present only for llm_pick_among_replacements and llm_pick_under_prefix. */
  llm_context?: TrackBLlmContext;
}

// ---------------------------------------------------------------------------
// Stage 2 — Verdict / Reconciliation
// ---------------------------------------------------------------------------

export type SignalCount = 'two_signal' | 'single_a' | 'single_b' | 'zero';

export type ReconciliationSource = 'track_a' | 'track_b' | 'reconciled';

export type VerdictDecision = 'accept' | 'escalate';

export interface VerdictResult {
  decision: 'accept';
  final_code: string;
  confidence: number;
  rationale: string;
  source: ReconciliationSource;
  signal_count: SignalCount;
}

export interface VerdictEscalate {
  decision: 'escalate';
  signal_count: SignalCount;
  disagreement_summary: string;
}

export type StageVerdictOutput = VerdictResult | VerdictEscalate;

// ---------------------------------------------------------------------------
// Stage 3 — Sanity
// ---------------------------------------------------------------------------

export type SanityVerdict = 'PASS' | 'FLAG' | 'BLOCK';

export interface SanityResult {
  verdict: SanityVerdict;
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
  signal_count: SignalCount;
  track_a: TrackAResult | null;
  track_b: TrackBResult | null;
  verdict: StageVerdictOutput | null;
  sanity: SanityResult | null;
  stages: StageTrace[];
}

// ---------------------------------------------------------------------------
// Final pipeline output (consumed by declaration-runs/classification)
// ---------------------------------------------------------------------------

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
  description_classifier_code: string | null;
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
  signal_count: SignalCount;
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
