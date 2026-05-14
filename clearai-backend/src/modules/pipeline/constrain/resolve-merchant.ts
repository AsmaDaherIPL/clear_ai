/**
 * resolveMerchantCode — deterministic codebook walk + override lookup
 * + (small) LLM pick for multi-replacement disambiguation.
 *
 * Owns Track B's logic from the legacy pipeline, restructured as a
 * typed `MerchantResolution` discriminator. Used by the constrain
 * stage; not by anyone else.
 *
 * Decision tree:
 *
 *   1. raw_code null / empty                   → absent
 *   2. overrides_enabled && override hit       → override_applied
 *   3. length < 6 or > 12                      → malformed
 *   4. length == 12:
 *      a. not in codebook                       → unknown (not_in_codebook)
 *      b. active                                → active
 *      c. deleted, 0 replacements               → unknown (no_replacements)
 *      d. deleted, 1 replacement                → replaced_single
 *      e. deleted, N replacements:
 *         - LLM pick succeeds                  → llm_picked_replacement
 *         - LLM pick fails / no query signal   → unknown (llm_pick_failed_replacement)
 *                                                 with matched_prefix = HS6 of source
 *   5. length 6-11:
 *      a. expand prefix (10→8→6 fallback)
 *      b. 0 children                            → unknown (prefix_empty)
 *      c. 1 child                               → expanded_prefix (deterministic)
 *      d. N children:
 *         - LLM pick succeeds                  → expanded_prefix
 *         - LLM pick fails / no query signal   → unknown (llm_pick_failed_prefix)
 *                                                 with matched_prefix = matched walk anchor
 */
import { llmClassify } from '../classify/description-classifier/picker/llm-pick.js';
import { lookupTenantOverride } from '../classify/code-resolver/codebook-override.js';
import type { Candidate } from '../../../inference/retrieval/retrieve.js';
import { lookupCode, expandWithFallback, type HsCodeRecord } from './codebook.js';
import type { IdentifyResult } from '../identify/identify.types.js';
import type { MerchantResolution } from './constrain.types.js';

/**
 * Classify the raw merchant code's length into one of three buckets.
 *  - twelve_digit: 12 digits exactly → lookup against codebook
 *  - short_prefix: 6-11 digits → walk down to nearest codebook anchor
 *  - malformed:    everything else (0-5, 13+)
 */
function classifyLength(code: string): 'twelve_digit' | 'short_prefix' | 'malformed' {
  if (code.length === 12) return 'twelve_digit';
  if (code.length >= 6 && code.length <= 11) return 'short_prefix';
  return 'malformed';
}

/**
 * Build a minimal Candidate from a codebook row so the LLM picker can
 * be reused for the multi-replacement disambiguation case.
 */
function rowToCandidate(row: HsCodeRecord, rank: number): Candidate {
  return {
    code: row.code,
    description_en: row.description_en,
    description_ar: row.description_ar,
    parent10: row.code.slice(0, 10),
    path_en: '',
    path_ar: '',
    path_codes: [],
    vec_rank: null,
    bm25_rank: null,
    trgm_rank: null,
    vec_score: null,
    bm25_score: null,
    trgm_score: null,
    rrf_score: 1 / (rank + 1),
  };
}

/**
 * Extract the canonical retrieval-query string from an identify
 * result. clean_product → canonical; uninformative/multi_product →
 * null (signals "no description-side signal available"). Callers
 * MUST short-circuit when null rather than firing an LLM call with
 * an empty query — empty-query LLM picks waste budget and produce
 * unaudit-able guesses.
 */
function queryFromIdentify(identify: IdentifyResult): string | null {
  if (identify.kind === 'clean_product') return identify.canonical;
  return null;
}

/**
 * Pick one of multiple replacement codes given an item's identify
 * canonical. Returns the chosen code or null when the LLM could not
 * defensibly pick one. Returns null without firing an LLM call when
 * identify carries no description-side signal (see queryFromIdentify).
 */
async function pickAmongReplacements(
  replacements: string[],
  identify: IdentifyResult,
): Promise<string | null> {
  const query = queryFromIdentify(identify);
  // Short-circuit: no description signal → cannot defensibly pick.
  // Avoids wasted LLM call on multi_product / uninformative identify.
  if (query === null || query.length === 0) return null;

  const candidates = replacements.map((c, i) =>
    rowToCandidate(
      { code: c, is_deleted: false, replacement_codes: null, description_en: null, description_ar: null },
      i,
    ),
  );
  const result = await llmClassify({
    kind: 'describe',
    query,
    candidates,
    stage: 'constrain_pick',
  });
  if (result.llmStatus !== 'ok' || result.parseFailed) return null;
  const topFit =
    result.verdicts.find((v) => v.fit === 'fits') ?? result.verdicts.find((v) => v.fit === 'partial');
  return topFit ? topFit.code : null;
}

/**
 * Pick a leaf under a parent prefix when the prefix has multiple
 * children. Returns the chosen code or null when no defensible pick.
 * Returns null without firing an LLM call when identify carries no
 * description-side signal.
 */
async function pickUnderPrefix(
  children: HsCodeRecord[],
  matchedPrefix: string,
  identify: IdentifyResult,
): Promise<string | null> {
  const query = queryFromIdentify(identify);
  if (query === null || query.length === 0) return null;

  const candidates = children.slice(0, 20).map((r, i) => rowToCandidate(r, i));
  const result = await llmClassify({
    kind: 'expand',
    query,
    candidates,
    parentPrefix: matchedPrefix,
    stage: 'constrain_pick',
  });
  if (result.llmStatus !== 'ok' || result.parseFailed) return null;
  const topFit =
    result.verdicts.find((v) => v.fit === 'fits') ?? result.verdicts.find((v) => v.fit === 'partial');
  return topFit ? topFit.code : null;
}

/**
 * Resolve a raw merchant code into a typed MerchantResolution. Never
 * throws on LLM failures — those degrade to `unknown` with a `cause`
 * discriminator naming the specific failure mode and (when
 * applicable) the matched prefix preserved so scope.ts can downgrade
 * to a merchant_prefix anchor rather than discarding the signal.
 *
 * @param raw_code        Raw merchant code as parsed from upload (digits only,
 *                        may be null when no code supplied).
 * @param identify        Identify stage output. Used as the query string for
 *                        LLM picks when the codebook walk needs disambiguation.
 * @param operator_slug   Operator slug for override lookup scoping.
 * @param overrides_enabled  When false, skip the override lookup entirely.
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
      return {
        state: 'unknown',
        source_code: raw_code,
        cause: 'not_in_codebook',
        matched_prefix: null,
      };
    }
    if (!record.is_deleted) {
      return { state: 'active', resolved_code: record.code };
    }
    const replacements = record.replacement_codes ?? [];
    if (replacements.length === 0) {
      return {
        state: 'unknown',
        source_code: raw_code,
        cause: 'no_replacements',
        matched_prefix: null,
      };
    }
    if (replacements.length === 1) {
      return {
        state: 'replaced_single',
        resolved_code: replacements[0]!,
        source_code: raw_code,
      };
    }
    // Multiple replacements → LLM picks.
    const picked = await pickAmongReplacements(replacements, identify);
    if (picked === null) {
      // LLM pick failed. The source code is a real 12-digit code in
      // the codebook, so we know the HS6 prefix is valid — preserve
      // it so scope.ts can fall back to merchant_prefix at HS6
      // rather than discarding the merchant anchor entirely.
      return {
        state: 'unknown',
        source_code: raw_code,
        cause: 'llm_pick_failed_replacement',
        matched_prefix: raw_code.slice(0, 6),
      };
    }
    return {
      state: 'llm_picked_replacement',
      resolved_code: picked,
      source_code: raw_code,
      candidates: replacements,
    };
  }

  // 5. short_prefix (6-11 digits)
  const aligned = alignToCodebookPrefix(raw_code);
  const { children, matched_prefix } = await expandWithFallback(aligned);
  if (children.length === 0) {
    return {
      state: 'unknown',
      source_code: raw_code,
      cause: 'prefix_empty',
      matched_prefix: null,
    };
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
    // LLM pick failed but the prefix has valid children — preserve
    // matched_prefix so scope.ts can downgrade to merchant_prefix at
    // the matched length rather than discarding.
    return {
      state: 'unknown',
      source_code: raw_code,
      cause: 'llm_pick_failed_prefix',
      matched_prefix,
    };
  }
  return {
    state: 'expanded_prefix',
    resolved_code: picked,
    valid_prefix: matched_prefix,
    source_code: raw_code,
  };
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
