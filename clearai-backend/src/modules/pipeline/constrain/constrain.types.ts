/**
 * Typed contracts for the constrain stage (PR-A-3).
 *
 * Constrain absorbs Track B (codebook walk + override + replacement
 * disambiguation) and the 11-rule conflict-type classifier. It is
 * deterministic except for at most one small LLM call when the
 * merchant code points at a deprecated entry with multiple valid
 * replacements (the LLM-pick-among-replacements case).
 */
import type { IdentifyResult } from '../identify/identify.types.js';

/**
 * What `resolveMerchantCode` produced from walking the merchant-
 * supplied code through the ZATCA codebook + the per-operator
 * override table.
 *
 * Each `state` value is a different terminal of the walk; consumers
 * branch on `state` (discriminated union) and read only the fields
 * valid for that state.
 */
export type MerchantResolution =
  /** No merchant code on this row. */
  | { state: 'absent' }
  /** Code malformed at the parse stage (not 6-12 digits). */
  | { state: 'malformed'; source_code: string }
  /** 12-digit code, active in the codebook, used as-is. */
  | { state: 'active'; resolved_code: string }
  /** Deprecated 12-digit code with exactly one replacement; deterministic swap. */
  | { state: 'replaced_single'; resolved_code: string; source_code: string }
  /** Operator override matched; resolved_code is the override target. */
  | {
      state: 'override_applied';
      resolved_code: string;
      source_code: string;
      override_matched_length: number;
    }
  /**
   * Deprecated 12-digit code with multiple replacements; LLM picked
   * one. Carries the alternatives in `candidates` for audit.
   */
  | {
      state: 'llm_picked_replacement';
      resolved_code: string;
      source_code: string;
      candidates: string[];
    }
  /**
   * 6-11 digit prefix expanded by walking down the codebook. When
   * the walk found a single child the pick is deterministic; when
   * it found multiple, the LLM disambiguated. `valid_prefix` is the
   * deepest matched prefix (6/8/10) and is preserved so retrieval
   * can anchor at maximum granularity in the pick stage.
   */
  | {
      state: 'expanded_prefix';
      resolved_code: string;
      valid_prefix: string;
      source_code: string;
    }
  /**
   * Walk produced no defensible resolution. `cause` distinguishes
   * the five distinct failure modes so metrics and audit can
   * separate carrier data quality issues from LLM-side problems
   * (mirrors the pattern on IdentifyResult.uninformative.cause).
   *
   *   not_in_codebook    — 12-digit code does not appear in the codebook
   *   no_replacements    — deprecated 12-digit code with zero replacements
   *   llm_pick_failed_replacement — multi-replacement LLM pick produced no fit
   *   prefix_empty       — 6-11 digit prefix walk returned zero children
   *   llm_pick_failed_prefix — prefix had multiple children but LLM pick failed
   *
   * When the cause carries usable prefix information (the two
   * `llm_pick_failed_*` causes), `matched_prefix` is non-null so
   * scope.ts can downgrade gracefully to `merchant_prefix` at the
   * matched prefix rather than discarding the merchant signal.
   */
  | {
      state: 'unknown';
      source_code: string;
      cause:
        | 'not_in_codebook'
        | 'no_replacements'
        | 'llm_pick_failed_replacement'
        | 'prefix_empty'
        | 'llm_pick_failed_prefix';
      /**
       * The deepest valid prefix discovered during the walk, or null
       * when the walk never found a defensible anchor. Non-null on
       * `llm_pick_failed_replacement` (HS6 of the deprecated parent)
       * and `llm_pick_failed_prefix` (the matched prefix from the
       * codebook walk-down).
       */
      matched_prefix: string | null;
    };

/**
 * Per-call audit metadata for the constrain stage. Mirrors
 * IdentifyCallTrace from PR-A-2. Every code path through constrain
 * produces a trace row so PR-A-5's orchestrator gets uniform per-
 * row audit data.
 *
 * Constrain may fire 0, 1, or 2 LLM calls + 0 or 1 override DB
 * lookups + 1 or 2 codebook queries. The trace summarises the
 * cumulative result, not per-call detail (per-call detail lives in
 * `llm_call_metrics`).
 */
export interface ConstrainCallTrace {
  /** Whether resolveMerchantCode invoked any LLM call (replacement pick or prefix pick). */
  llm_called: boolean;
  /**
   * Total wall-clock latency for resolveMerchantCode + scopeFrom in
   * milliseconds. Includes DB queries and any LLM calls.
   */
  latency_ms: number;
  /**
   * Was the override lookup attempted on this row?
   * False when overrides_enabled=false OR when raw_merchant_code is
   * null. Useful for ops debugging "why didn't my override fire?".
   */
  override_attempted: boolean;
  /**
   * Did the override lookup return a match?
   * Always false when override_attempted=false.
   */
  override_matched: boolean;
}

/**
 * The retrieval scope `constrain` decides. Drives the prefix filter
 * passed to retrieveCandidates() in the pick stage.
 */
export type RetrievalScope =
  | {
      kind: 'merchant_prefix';
      /**
       * Prefix to filter retrieval. 6+ digits = subheading anchor.
       * Always >= 4 digits when set.
       */
      prefix: string;
      /** Where the prefix came from. */
      source:
        | 'merchant_active'
        | 'merchant_replacement_single'
        | 'merchant_override'
        | 'merchant_replacement_picked'
        | 'merchant_expanded';
      /**
       * True when the picker should treat this scope with extra
       * scrutiny — e.g. an LLM pick disambiguated multiple
       * replacements (ambiguity baked into the anchor).
       */
      audit_flag: boolean;
    }
  | {
      kind: 'family_chapter';
      /** 2-digit chapter from identify.family_chapter. */
      chapter: string;
      source: 'identify';
      /**
       * True when scope is identify-only even though a merchant
       * resolution exists — set when override target chapter
       * disagrees with identify.family_chapter at high confidence
       * (the "operator override known-dirty" case).
       */
      audit_flag: boolean;
    }
  | {
      kind: 'unconstrained';
      /**
       * Why retrieval is running without a prefix filter. Always
       * accompanied by a degraded signal upstream.
       */
      reason: 'no_merchant_low_confidence_identify' | 'merchant_unknown_no_family';
    }
  | {
      kind: 'escalate';
      /**
       * Why no defensible retrieval scope exists. Pick stage skips
       * retrieval entirely and emits an escalate signal.
       */
      reason:
        | 'identify_multi_product'
        | 'identify_uninformative_no_merchant'
        | 'merchant_malformed_no_family';
    };

export interface ConstrainInput {
  identify: IdentifyResult;
  /**
   * Raw merchant code as supplied by the carrier upload (post
   * non-digit strip from parse). May be null when the carrier did
   * not supply a code.
   */
  raw_merchant_code: string | null;
  operator_slug: string;
  /**
   * Mirrors the operator's `overrides_enabled` flag. When false,
   * the override lookup is skipped (the operator's override list is
   * operationally untrusted but we don't delete the rows).
   */
  overrides_enabled: boolean;
}

export interface ConstrainResult {
  resolution: MerchantResolution;
  scope: RetrievalScope;
  trace: ConstrainCallTrace;
}
