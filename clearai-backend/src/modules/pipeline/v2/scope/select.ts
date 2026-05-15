/**
 * Pipeline rewrite — Stage 4: scope_selection (PR 6).
 *
 * Pure deterministic function. Inputs: identify (post-fast-pass and
 * post-web-fallback) + merchant_resolution. Output: ScopeSelection
 * with one primary RetrievalArm + zero or more secondary arms +
 * audit_flags describing how the decision was reached.
 *
 * No LLM. No I/O. No async. Same inputs → same output, always.
 *
 * Rules (priority order — first match wins for primary):
 *
 *   1. identify.kind === 'multi_product' AND no clean merchant resolution
 *      → primary = escalate(identify_multi_product), no secondaries
 *   2. identify.kind === 'uninformative' AND no clean merchant resolution
 *      → primary = escalate(identify_uninformative_no_merchant)
 *   3. merchant_resolution resolves cleanly (active / replaced_single /
 *      override_applied / llm_picked_replacement / expanded_prefix)
 *      → primary = merchant_prefix(resolved_code's prefix)
 *      → secondaries computed per "secondary arm rules" below
 *   4. merchant_resolution.state === 'malformed' AND identify.clean_product
 *      with family_chapter → primary = family_chapter(identify.family_chapter)
 *   5. identify.kind === 'clean_product' with family_chapter AND no clean
 *      merchant resolution → primary = family_chapter(identify.family_chapter)
 *   6. identify.kind === 'clean_product' with family_chapter=null AND no
 *      merchant resolution → primary = unconstrained
 *   7. fallback (rare) → primary = escalate(merchant_malformed_no_family)
 *
 * Secondary arm rules (only apply when primary.kind === 'merchant_prefix'):
 *
 *   override suppression:
 *     if merchant_resolution.state === 'override_applied':
 *       no secondaries; audit_flags = [override_suppresses_secondary]
 *       (override is presumed-authoritative per operator's curated knowledge)
 *
 *   chapter disagreement:
 *     if identify.kind === 'clean_product' AND identify.confidence >= 0.85
 *        AND identify.family_chapter !== null
 *        AND identify.family_chapter !== first-two-of-merchant-prefix:
 *       add { kind: family_chapter, chapter: identify.family_chapter, source: identify }
 *       audit_flags.add(merchant_chapter_disagreement)
 *
 *   composite product:
 *     if identify.kind === 'clean_product' AND identify.confidence >= 0.85
 *        AND identify.family_chapter === null:
 *       add { kind: unconstrained, reason: composite_product }
 *       audit_flags.add(identify_family_null)
 *
 *   lexical tokens:
 *     if identify.kind === 'clean_product' AND identity_tokens.length > 0:
 *       add { kind: lexical_tokens, tokens: identify.identity_tokens }
 *       (no audit flag — additive, harmless)
 *
 * Confidence threshold 0.85 (not 0.90 as the verifier uses): per Q4
 * decision 2026-05-15, scope selection is more permissive than the
 * verifier because we want a wider candidate pool when the merchant
 * may be wrong. The verifier then judges the picker's choice using
 * the tighter 0.90 threshold.
 */
import type {
  IdentifyResult,
  MerchantResolution,
  RetrievalArm,
  ScopeAuditFlag,
  ScopeSelection,
} from '../types.js';

/**
 * Confidence threshold for adding identify-side secondary arms.
 *
 * Calibration note (2026-05-15 batch analysis): identify_fast produces
 * confidence in the 0.62-0.97 range; most clean_product rows land in
 * 0.72-0.85. The original 0.85 threshold caused secondary arms to
 * never fire on those rows, which combined with a too-specific merchant
 * prefix (e.g. 8-10 digit) returning only 1 candidate produced the
 * 14-row `no_candidate_fits` cluster.
 *
 * Loosening to 0.70 keeps the chapter-disagreement signal meaningful
 * (random-guess confidence under the fast pass is ~0.5, never above
 * 0.6) while letting the secondary arm widen retrieval on the majority
 * of rows where identify has a clear-enough family chapter. The
 * verifier still uses its tighter 0.90 threshold; this only affects
 * what we RETRIEVE, not what we ACCEPT.
 */
const IDENTIFY_CONFIDENCE_THRESHOLD = 0.70;

/** Resolved-code states where the merchant produced an actionable prefix. */
const MERCHANT_RESOLVED_STATES = new Set([
  'active',
  'replaced_single',
  'override_applied',
  'llm_picked_replacement',
  'expanded_prefix',
]);

/**
 * True when merchant_resolution gives us a usable prefix to retrieve
 * against. Includes the cleanly-resolved states plus `unknown` with a
 * non-null `matched_prefix` — those are codes that didn't match an
 * exact codebook entry but where the walk did recognize a partial
 * prefix (HS6/HS8). That prefix is still authoritative signal: the
 * merchant clearly thinks the product belongs in that family, and
 * retrieval filtered to that prefix is better than no merchant arm.
 *
 * The original `merchantResolvedCleanly` guard treated `unknown` as
 * "no merchant signal" and dropped to identify-only, which escalated
 * scope-rule-1 on multi_product / uninformative identify even when the
 * merchant prefix was usable. The relaxed guard rescues those rows.
 */
function merchantHasUsablePrefix(r: MerchantResolution): boolean {
  if (MERCHANT_RESOLVED_STATES.has(r.state)) return true;
  if (r.state === 'unknown' && r.matched_prefix !== null) return true;
  return false;
}

/**
 * Get the merchant prefix to filter retrieval against. We use the
 * resolved code's first 8 digits when available (HS8 = most-specific
 * common subheading level), or the deepest valid prefix the walk
 * found when expanded.
 */
function merchantPrefixFor(r: MerchantResolution): string | null {
  if (r.state === 'active') return r.resolved_code.slice(0, 8);
  if (r.state === 'replaced_single') return r.resolved_code.slice(0, 8);
  if (r.state === 'override_applied') return r.resolved_code.slice(0, 8);
  if (r.state === 'llm_picked_replacement') return r.resolved_code.slice(0, 8);
  if (r.state === 'expanded_prefix') return r.valid_prefix; // deepest matched (6/8/10)
  // Degraded path: unknown with a matched_prefix from the codebook walk.
  // The merchant gave a code that didn't resolve to an exact entry but
  // the walk recognized e.g. HS6. Use it as a wider merchant arm.
  if (r.state === 'unknown' && r.matched_prefix !== null) return r.matched_prefix;
  return null;
}

function merchantSourceFor(
  r: MerchantResolution,
): 'merchant_active' | 'merchant_expanded' | 'merchant_replacement_picked' | 'override_applied' {
  switch (r.state) {
    case 'override_applied':
      return 'override_applied';
    case 'expanded_prefix':
      return 'merchant_expanded';
    case 'llm_picked_replacement':
    case 'replaced_single':
      return 'merchant_replacement_picked';
    case 'active':
      return 'merchant_active';
    default:
      // Reached on the `unknown` + matched_prefix degraded path; the
      // merchant arm uses the recognized prefix (HS6/HS8). Label as
      // 'merchant_expanded' since semantically the walk expanded what
      // the merchant gave into the deepest valid prefix.
      return 'merchant_expanded';
  }
}

/**
 * Pure function: identify + merchant_resolution → ScopeSelection.
 * Same inputs always produce the same output.
 */
export function selectScopes(
  identify: IdentifyResult,
  merchantResolution: MerchantResolution,
): ScopeSelection {
  // Rule 1: multi_product + no usable merchant prefix → escalate.
  // Updated 2026-05-15 to use merchantHasUsablePrefix() (instead of the
  // tighter merchantResolvedCleanly) so a merchant code that walked to
  // `unknown` but recognized an HS6/HS8 prefix still gets a chance.
  // The picker's multi_product fallback (uses products[0] as query)
  // will run against the merchant arm and verdict the dominant product.
  if (identify.kind === 'multi_product' && !merchantHasUsablePrefix(merchantResolution)) {
    return {
      primary: { kind: 'escalate', reason: 'identify_multi_product' },
      secondaries: [],
      audit_flags: [],
    };
  }

  // Rule 2: uninformative + no usable merchant prefix → escalate.
  if (identify.kind === 'uninformative' && !merchantHasUsablePrefix(merchantResolution)) {
    return {
      primary: { kind: 'escalate', reason: 'identify_uninformative_no_merchant' },
      secondaries: [],
      audit_flags: [],
    };
  }

  // Rule 3: merchant has a usable prefix → primary = merchant_prefix.
  // Covers both the cleanly-resolved states (active / replaced_single /
  // override_applied / llm_picked_replacement / expanded_prefix) AND
  // the degraded `unknown` with matched_prefix path. The latter uses
  // the partial HS6/HS8 prefix the codebook walk recognized.
  if (merchantHasUsablePrefix(merchantResolution)) {
    const prefix = merchantPrefixFor(merchantResolution);
    if (prefix === null) {
      // Defensive: merchantHasUsablePrefix guarantees prefix is
      // non-null. Reaching here is a programmer error.
      throw new Error(
        `scope_selection invariant: merchant has usable prefix but merchantPrefixFor returned null (state=${merchantResolution.state})`,
      );
    }
    const primary: RetrievalArm = {
      kind: 'merchant_prefix',
      prefix,
      source: merchantSourceFor(merchantResolution),
    };

    // Override suppression: operator's curated override is authoritative.
    if (merchantResolution.state === 'override_applied') {
      return {
        primary,
        secondaries: [],
        audit_flags: ['override_suppresses_secondary'],
      };
    }

    // Compute secondary arms.
    const secondaries: RetrievalArm[] = [];
    const auditFlags: ScopeAuditFlag[] = [];

    if (
      identify.kind === 'clean_product' &&
      identify.confidence >= IDENTIFY_CONFIDENCE_THRESHOLD
    ) {
      const merchantChapter = prefix.slice(0, 2);

      if (
        identify.family_chapter !== null &&
        identify.family_chapter !== merchantChapter
      ) {
        // Chapter disagreement: identify says different chapter with high
        // confidence. Add identify-side arm, flag for audit.
        secondaries.push({
          kind: 'family_chapter',
          chapter: identify.family_chapter,
          source: 'identify',
        });
        auditFlags.push('merchant_chapter_disagreement');
      } else if (identify.family_chapter === null) {
        // Composite product case: identify can't commit to a chapter.
        // Add unconstrained arm so retrieval doesn't get starved.
        secondaries.push({
          kind: 'unconstrained',
          reason: 'composite_product',
        });
        auditFlags.push('identify_family_null');
      }
    }

    // Lexical tokens arm. Fires whenever identify produced tokens —
    // independent of the IDENTIFY_CONFIDENCE_THRESHOLD gate above. The
    // tokens are deterministic content (brand + product noun); the
    // arm carries no risk because lexical retrieval only matches what's
    // already in the codebook descriptions. Worst case it returns 0
    // candidates; in practice it rescues the long tail where the
    // merchant prefix is too specific (8-10 digits) and produces 1
    // candidate from the wrong leaf.
    if (identify.kind === 'clean_product') {
      if (identify.identity_tokens.length > 0) {
        secondaries.push({
          kind: 'lexical_tokens',
          tokens: identify.identity_tokens,
        });
      }
    }

    // Multi-product rescue: when identify split the row into multiple
    // products, the picker runs against the first product but the
    // merchant prefix may be locked to the wrong heading for it (e.g.
    // merchant 6206 = women's shirts, but products[0] is a skirt which
    // belongs in 6204). Add a lexical_tokens secondary using the first
    // product as the query string so retrieval can broaden beyond the
    // merchant prefix. Also fire unconstrained so the picker has at
    // least one cross-chapter rescue path.
    if (identify.kind === 'multi_product' && identify.products.length > 0) {
      const firstProductTokens = identify.products[0]!
        .split(/[\s,]+/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 2);
      if (firstProductTokens.length > 0) {
        secondaries.push({
          kind: 'lexical_tokens',
          tokens: firstProductTokens,
        });
      }
      secondaries.push({
        kind: 'unconstrained',
        reason: 'composite_product',
      });
      auditFlags.push('identify_family_null');
    }

    return { primary, secondaries, audit_flags: auditFlags };
  }

  // Rule 4: merchant malformed + identify clean_product with family.
  if (
    merchantResolution.state === 'malformed' &&
    identify.kind === 'clean_product' &&
    identify.family_chapter !== null
  ) {
    return {
      primary: {
        kind: 'family_chapter',
        chapter: identify.family_chapter,
        source: 'identify',
      },
      secondaries:
        identify.identity_tokens.length > 0
          ? [{ kind: 'lexical_tokens', tokens: identify.identity_tokens }]
          : [],
      audit_flags: [],
    };
  }

  // Rule 5: identify clean_product with family AND no clean merchant
  // (covers absent + unknown merchant states).
  if (identify.kind === 'clean_product' && identify.family_chapter !== null) {
    return {
      primary: {
        kind: 'family_chapter',
        chapter: identify.family_chapter,
        source: 'identify',
      },
      secondaries:
        identify.identity_tokens.length > 0
          ? [{ kind: 'lexical_tokens', tokens: identify.identity_tokens }]
          : [],
      audit_flags: [],
    };
  }

  // Rule 6: identify clean_product with family_chapter=null AND no
  // clean merchant → unconstrained retrieval.
  if (identify.kind === 'clean_product' && identify.family_chapter === null) {
    return {
      primary: {
        kind: 'unconstrained',
        reason: 'no_merchant_low_confidence_identify',
      },
      secondaries:
        identify.identity_tokens.length > 0
          ? [{ kind: 'lexical_tokens', tokens: identify.identity_tokens }]
          : [],
      audit_flags: [],
    };
  }

  // Rule 7: fallback — merchant malformed + identify gave up.
  return {
    primary: { kind: 'escalate', reason: 'merchant_malformed_no_family' },
    secondaries: [],
    audit_flags: [],
  };
}
