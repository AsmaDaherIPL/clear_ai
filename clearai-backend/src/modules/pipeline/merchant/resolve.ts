/**
 * Merchant resolution — Stage 3 of the pipeline.
 *
 * Deterministic codebook walk + override lookup + multi-replacement LLM
 * disambiguation. Moved from constrain/resolve-merchant.ts and promoted
 * to the canonical merchant/ namespace in PR 13.
 *
 * Decision tree:
 *
 *   1. raw_code null / empty                   -> absent
 *   2. overrides_enabled && override hit       -> override_applied
 *   3. length < 6 or > 12                      -> malformed
 *   4. length == 12:
 *      a. not in codebook                       -> unknown (not_in_codebook)
 *      b. active                                -> active
 *      c. deleted, 0 replacements               -> unknown (no_replacements)
 *      d. deleted, 1 replacement                -> replaced_single
 *      e. deleted, N replacements:
 *         - LLM pick succeeds                  -> llm_picked_replacement
 *         - LLM pick fails / no query signal   -> unknown (llm_pick_failed_replacement)
 *                                                 with matched_prefix = HS6 of source
 *   5. length 6-11:
 *      a. expand prefix (10->8->6 fallback)
 *      b. 0 children                            -> unknown (prefix_empty)
 *      c. 1 child                               -> expanded_prefix (deterministic)
 *      d. N children:
 *         - LLM pick succeeds                  -> expanded_prefix
 *         - LLM pick fails / no query signal   -> unknown (llm_pick_failed_prefix)
 *                                                 with matched_prefix = matched walk anchor
 */
import { lookupCode, expandWithFallback } from './codebook.js';
import { lookupTenantOverride } from './codebook-override.js';
import { pickAmongReplacements, pickUnderPrefix } from './replacement-pick.js';
import type { MerchantResolution, MerchantResolutionTrace } from '../types.js';
import type { IdentifyResult } from '../types.js';

/**
 * Classify the raw merchant code's length into one of three buckets.
 *  - twelve_digit: 12 digits exactly -> lookup against codebook
 *  - short_prefix: 6-11 digits -> walk down to nearest codebook anchor
 *  - malformed:    everything else (0-5, 13+)
 */
function classifyLength(code: string): 'twelve_digit' | 'short_prefix' | 'malformed' {
  if (code.length === 12) return 'twelve_digit';
  if (code.length >= 6 && code.length <= 11) return 'short_prefix';
  return 'malformed';
}

/**
 * Truncate a 6-11 digit code to the nearest aligned codebook prefix
 * length. No-op for 6/8/10. Required because 7/9/11-digit codes don't
 * align with codebook granularity.
 */
function alignToCodebookPrefix(code: string): string {
  if (code.length === 6 || code.length === 8 || code.length === 10) return code;
  if (code.length === 11) return code.slice(0, 10);
  if (code.length === 9) return code.slice(0, 8);
  if (code.length === 7) return code.slice(0, 6);
  return code;
}

/**
 * Resolve a raw merchant code into a typed MerchantResolution. Never
 * throws on LLM failures — those degrade to `unknown` with a `cause`
 * discriminator. The IdentifyResult is used as a tiebreaker when the
 * codebook walk needs LLM disambiguation.
 *
 * @param raw_code        Raw merchant code (digits only, may be null).
 * @param identify        Identify stage output (used as query for LLM picks).
 * @param operator_slug   Operator slug for override lookup scoping.
 * @param overrides_enabled  When false, skip the override lookup.
 */
export async function resolveMerchantCode(
  raw_code: string | null,
  identify: IdentifyResult,
  operator_slug: string,
  overrides_enabled: boolean,
): Promise<MerchantResolution> {
  // 1. absent
  if (raw_code === null || raw_code.length === 0) {
    return { state: 'absent' };
  }

  // 2. override (runs BEFORE length classification because the override
  //    table may key on non-standard lengths and an operator override is
  //    a curated remap that should win when configured).
  if (overrides_enabled) {
    const override = await lookupTenantOverride(raw_code, operator_slug);
    if (override !== null) {
      return {
        state: 'override_applied',
        resolved_code: override.targetCode,
        source_code: raw_code,
        override_matched_length: override.matchedLength,
      };
    }
  }

  // 3. malformed (after override).
  const lengthState = classifyLength(raw_code);
  if (lengthState === 'malformed') {
    return { state: 'malformed', source_code: raw_code };
  }

  // 4. 12-digit
  if (lengthState === 'twelve_digit') {
    const record = await lookupCode(raw_code);
    if (record === null) {
      return { state: 'unknown', source_code: raw_code, cause: 'not_in_codebook', matched_prefix: null };
    }
    if (!record.is_deleted) {
      return { state: 'active', resolved_code: record.code };
    }
    const replacements = record.replacement_codes ?? [];
    if (replacements.length === 0) {
      return { state: 'unknown', source_code: raw_code, cause: 'no_replacements', matched_prefix: null };
    }
    if (replacements.length === 1) {
      return { state: 'replaced_single', resolved_code: replacements[0]!, source_code: raw_code };
    }
    // Multiple replacements -> LLM picks.
    const picked = await pickAmongReplacements(replacements, identify);
    if (picked === null) {
      return {
        state: 'unknown',
        source_code: raw_code,
        cause: 'llm_pick_failed_replacement',
        matched_prefix: raw_code.slice(0, 6),
      };
    }
    return { state: 'llm_picked_replacement', resolved_code: picked, source_code: raw_code, candidates: replacements };
  }

  // 5. short_prefix (6-11 digits)
  const aligned = alignToCodebookPrefix(raw_code);
  const { children, matched_prefix } = await expandWithFallback(aligned);
  if (children.length === 0) {
    return { state: 'unknown', source_code: raw_code, cause: 'prefix_empty', matched_prefix: null };
  }
  if (children.length === 1) {
    return {
      state: 'expanded_prefix',
      resolved_code: children[0]!.code,
      valid_prefix: matched_prefix,
      source_code: raw_code,
    };
  }
  const picked = await pickUnderPrefix(children, matched_prefix, identify);
  if (picked === null) {
    return { state: 'unknown', source_code: raw_code, cause: 'llm_pick_failed_prefix', matched_prefix };
  }
  return { state: 'expanded_prefix', resolved_code: picked, valid_prefix: matched_prefix, source_code: raw_code };
}

/**
 * Convenience wrapper matching the v2 orchestrator's call signature.
 * Delegates to resolveMerchantCode with the canonical types.
 */
export async function resolveMerchant(
  raw_code: string | null,
  identify: IdentifyResult,
  operator_slug: string,
  overrides_enabled: boolean,
): Promise<MerchantResolution> {
  return resolveMerchantCode(raw_code, identify, operator_slug, overrides_enabled);
}

/**
 * Build a MerchantResolutionTrace from a resolution outcome + facts about
 * how we got there. Exported so the orchestrator can attach the trace.
 */
export function buildResolutionTrace(
  resolution: MerchantResolution,
  startMs: number,
  llmCalled: boolean,
  overrideAttempted: boolean,
): MerchantResolutionTrace {
  return {
    llm_called: llmCalled,
    latency_ms: Date.now() - startMs,
    override_attempted: overrideAttempted,
    override_matched: resolution.state === 'override_applied',
  };
}
