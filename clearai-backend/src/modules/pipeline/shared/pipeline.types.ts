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
