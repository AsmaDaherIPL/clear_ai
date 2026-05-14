/**
 * scopeFrom — deterministic retrieval-scope selector.
 *
 * Replaces the legacy 11-rule conflict-type classifier with a typed
 * decision over (IdentifyResult, MerchantResolution). Pure function;
 * no LLM, no DB.
 *
 * The decision tree, in order:
 *
 *   1. identify.multi_product → escalate (multi_product)
 *   2. identify.uninformative
 *      - merchant has anchorable code → merchant_prefix scope
 *      - merchant malformed → escalate (malformed)
 *      - merchant unknown / absent → unconstrained or escalate
 *   3. clean_product
 *      - if merchant has anchorable code (active/replaced/override/expanded/picked):
 *        - check override-vs-identify chapter mismatch:
 *          - override target chapter != identify.family_chapter AND
 *            identify confidence >= IDENTIFY_BEATS_OVERRIDE_THRESHOLD
 *            AND identify.family_chapter !== null → family_chapter
 *            scope with audit_flag (the dirty-override case)
 *        - else merchant_prefix scope
 *      - else if identify confident with family_chapter → family_chapter scope
 *      - else if merchant absent/unknown → unconstrained
 *      - else → unconstrained
 */
import type { IdentifyResult } from '../identify/identify.types.js';
import type { MerchantResolution, RetrievalScope } from './constrain.types.js';

/**
 * Identify confidence required to override an `override_applied`
 * merchant resolution when the chapters disagree. Set high because
 * overrides represent operator curation — we only override that
 * curation when identify is very sure.
 */
const IDENTIFY_BEATS_OVERRIDE_THRESHOLD = 0.7;

/**
 * Identify confidence required to anchor retrieval on family_chapter
 * when no merchant code is available. Lower than the
 * IDENTIFY_BEATS_OVERRIDE_THRESHOLD because there's no competing
 * curated signal.
 */
const IDENTIFY_FAMILY_CONFIDENCE_THRESHOLD = 0.7;

/** Extract the 2-digit chapter from a resolved 12-digit code, or null. */
function chapterOf(code: string | null): string | null {
  if (!code || code.length < 2) return null;
  return code.slice(0, 2);
}

/**
 * Extract the retrieval-anchor prefix for a given resolution state.
 *
 * Granularity policy:
 *   - active / replaced_single / override_applied / llm_picked_replacement
 *     → HS6 (first 6 digits of resolved_code). HS6 is the international
 *       harmonized prefix; the picker resolves the leaf within.
 *   - expanded_prefix → resolution.valid_prefix (already 6/8/10 from the
 *     codebook walk-down). Preserves max granularity when the carrier
 *     supplied an HS8 or HS10 prefix that resolved cleanly.
 */
function prefixForRetrieval(
  resolution: Extract<
    MerchantResolution,
    {
      state:
        | 'active'
        | 'replaced_single'
        | 'override_applied'
        | 'llm_picked_replacement'
        | 'expanded_prefix';
    }
  >,
): string {
  if (resolution.state === 'expanded_prefix') return resolution.valid_prefix;
  return resolution.resolved_code.slice(0, 6);
}

/**
 * Map a merchant resolution state to the scope.source value when
 * building a merchant_prefix scope.
 */
function sourceFromState(state: MerchantResolution['state']):
  | 'merchant_active'
  | 'merchant_replacement_single'
  | 'merchant_override'
  | 'merchant_replacement_picked'
  | 'merchant_expanded'
  | null {
  switch (state) {
    case 'active':
      return 'merchant_active';
    case 'replaced_single':
      return 'merchant_replacement_single';
    case 'override_applied':
      return 'merchant_override';
    case 'llm_picked_replacement':
      return 'merchant_replacement_picked';
    case 'expanded_prefix':
      return 'merchant_expanded';
    case 'absent':
    case 'malformed':
    case 'unknown':
      return null;
  }
}

/**
 * True when the merchant resolution produced a code we can anchor
 * retrieval against. Excludes `absent`, `malformed`, `unknown`.
 */
function hasAnchorableCode(
  resolution: MerchantResolution,
): resolution is Extract<
  MerchantResolution,
  { state: 'active' | 'replaced_single' | 'override_applied' | 'llm_picked_replacement' | 'expanded_prefix' }
> {
  return (
    resolution.state === 'active' ||
    resolution.state === 'replaced_single' ||
    resolution.state === 'override_applied' ||
    resolution.state === 'llm_picked_replacement' ||
    resolution.state === 'expanded_prefix'
  );
}

/**
 * If an `unknown` resolution preserved a `matched_prefix` (LLM pick
 * failed on a multi-replacement or prefix-walk but the prefix is
 * valid), return that prefix so scope can downgrade to a
 * merchant_prefix anchor at the matched length rather than
 * discarding the merchant signal entirely. Returns null when the
 * resolution is `unknown` but has no salvageable prefix
 * (not_in_codebook, no_replacements, prefix_empty).
 */
function unknownSalvageablePrefix(resolution: MerchantResolution): string | null {
  if (resolution.state !== 'unknown') return null;
  return resolution.matched_prefix;
}

export function scopeFrom(
  identify: IdentifyResult,
  resolution: MerchantResolution,
): RetrievalScope {
  // Rule 1: multi_product short-circuits regardless of merchant.
  if (identify.kind === 'multi_product') {
    return { kind: 'escalate', reason: 'identify_multi_product' };
  }

  // Rule 2: uninformative — merchant signal decides.
  if (identify.kind === 'uninformative') {
    if (hasAnchorableCode(resolution)) {
      const source = sourceFromState(resolution.state);
      // narrow: hasAnchorableCode guarantees a non-null source
      if (source === null) throw new Error('scope: invariant violated (anchorable without source)');
      return {
        kind: 'merchant_prefix',
        prefix: prefixForRetrieval(resolution),
        source,
        audit_flag: resolution.state === 'llm_picked_replacement',
      };
    }
    // Unknown with a salvageable matched_prefix: LLM pick failed but
    // the prefix is real — anchor on it with audit_flag rather than
    // discarding the merchant signal.
    const salvage = unknownSalvageablePrefix(resolution);
    if (salvage !== null) {
      return {
        kind: 'merchant_prefix',
        prefix: salvage,
        // The merchant supplied a real anchor; we just couldn't pick
        // the leaf. From scope's POV this is the same operation as
        // llm_picked_replacement (ambiguity at the leaf level).
        source: 'merchant_replacement_picked',
        audit_flag: true,
      };
    }
    if (resolution.state === 'malformed') {
      return { kind: 'escalate', reason: 'merchant_malformed_no_family' };
    }
    if (resolution.state === 'unknown') {
      return { kind: 'unconstrained', reason: 'merchant_unknown_no_family' };
    }
    // absent
    return { kind: 'escalate', reason: 'identify_uninformative_no_merchant' };
  }

  // Rule 3: clean_product.
  if (hasAnchorableCode(resolution)) {
    // Override-vs-identify chapter mismatch (the dirty-override case).
    // Only fires when:
    //   - state is override_applied
    //   - override target chapter != identify.family_chapter
    //   - identify has high confidence
    //   - identify produced a family_chapter
    if (
      resolution.state === 'override_applied' &&
      identify.family_chapter !== null &&
      identify.confidence >= IDENTIFY_BEATS_OVERRIDE_THRESHOLD
    ) {
      const overrideChapter = chapterOf(resolution.resolved_code);
      if (overrideChapter !== null && overrideChapter !== identify.family_chapter) {
        return {
          kind: 'family_chapter',
          chapter: identify.family_chapter,
          source: 'identify',
          audit_flag: true,
        };
      }
    }

    const source = sourceFromState(resolution.state);
    if (source === null) throw new Error('scope: invariant violated (anchorable without source)');
    return {
      kind: 'merchant_prefix',
      prefix: prefixForRetrieval(resolution),
      source,
      audit_flag: resolution.state === 'llm_picked_replacement',
    };
  }

  // Unknown-with-salvageable-prefix: prefer the merchant anchor even
  // for clean_product, because LLM-pick-failed-on-valid-prefix is
  // strictly more anchor than the identify family hint alone.
  const salvage = unknownSalvageablePrefix(resolution);
  if (salvage !== null) {
    return {
      kind: 'merchant_prefix',
      prefix: salvage,
      source: 'merchant_replacement_picked',
      audit_flag: true,
    };
  }

  // clean_product without anchorable merchant code: use identify
  // family hint if confident.
  if (
    identify.family_chapter !== null &&
    identify.confidence >= IDENTIFY_FAMILY_CONFIDENCE_THRESHOLD
  ) {
    return {
      kind: 'family_chapter',
      chapter: identify.family_chapter,
      source: 'identify',
      audit_flag: false,
    };
  }

  // clean_product, no anchorable merchant, no confident family.
  if (resolution.state === 'malformed') {
    return { kind: 'unconstrained', reason: 'no_merchant_low_confidence_identify' };
  }
  if (resolution.state === 'absent') {
    return { kind: 'unconstrained', reason: 'no_merchant_low_confidence_identify' };
  }
  // resolution.state === 'unknown' with no salvageable prefix.
  return { kind: 'unconstrained', reason: 'merchant_unknown_no_family' };
}
