/**
 * Pipeline rewrite — Stage 6: deterministic reranker v1 (PR 8).
 *
 * Pure function. Re-scores deduped candidates using 6 cheap features
 * available today, sorts descending, returns top RERANK_CAP candidates.
 *
 * Features (all deterministic, no LLM, no I/O):
 *   1. rrf_score        — base retrieval score (already on candidate)
 *   2. chapter_agreement — boolean: leaf chapter matches identify.family_chapter
 *   3. identity_token_overlap_count — count of identify.identity_tokens
 *      that appear as substrings in the leaf's description text (EN + AR)
 *   4. arm_boost         — additive adjustment based on source_arm:
 *                          merchant_prefix:    +0.03 (some authority weight)
 *                          family_chapter:     +0.00 (neutral)
 *                          lexical_tokens:     +0.02 (specific brand/SKU lookup)
 *                          unconstrained:      -0.02 (no anchor, less trustworthy)
 *
 *   Note: the 6 features listed in the plan ("embedding similarity",
 *   "BM25", "trigram", chapter, identity overlap, arm boost) are
 *   compressed here — embedding/BM25/trigram are already fused into
 *   rrf_score by retrieval, so the reranker's job is to ADD information
 *   the retrieval didn't have (chapter agreement, identity overlap,
 *   arm authority) rather than recompute the base hybrid score.
 *
 * Cap = 8 per Q4 (2026-05-15): trims the picker's prompt size to honor
 * the p50 ≤ 15s latency target. The picker sees 8 candidates, not 12.
 */
import type {
  IdentifyResult,
  RerankedCandidate,
  RerankFeatures,
  ScoredCandidate,
} from '../types.js';

export const RERANK_CAP = 8;

/** Per-feature contributions to rerank_score. */
const CHAPTER_AGREEMENT_BOOST = 0.10;
const IDENTITY_TOKEN_OVERLAP_PER_MATCH = 0.05;
const IDENTITY_TOKEN_OVERLAP_MAX = 0.20;

/** Arm-specific boost. Tunable; current values picked by intent (see file header). */
const ARM_BOOSTS: Record<ScoredCandidate['source_arm'], number> = {
  merchant_prefix: 0.03,
  family_chapter: 0.0,
  lexical_tokens: 0.02,
  unconstrained: -0.02,
};

function chapterOf(code: string): string {
  return code.slice(0, 2);
}

/**
 * Count identity_tokens that appear (case-insensitively, substring) in
 * the leaf's English or Arabic description. Each token counts at most
 * once total across both languages.
 *
 * We're deliberately permissive (substring not word-boundary) because
 * customs descriptions sometimes embed tokens inside larger phrases
 * (e.g. "panthenol" inside "panthenol-based skincare preparations").
 */
function countTokenOverlaps(
  tokens: readonly string[],
  description_en: string | null,
  description_ar: string | null,
): number {
  if (tokens.length === 0) return 0;
  const haystackEn = (description_en ?? '').toLowerCase();
  const haystackAr = description_ar ?? ''; // Arabic — no lowercasing (irrelevant)

  let count = 0;
  for (const token of tokens) {
    const trimmed = token.trim();
    if (trimmed.length === 0) continue;
    const tokenLower = trimmed.toLowerCase();
    // Match in either language counts as one.
    if (haystackEn.includes(tokenLower) || haystackAr.includes(trimmed)) {
      count++;
    }
  }
  return count;
}

function extractFeatures(
  c: ScoredCandidate,
  identify: IdentifyResult,
): RerankFeatures {
  const chapterAgreement =
    identify.kind === 'clean_product' &&
    identify.family_chapter !== null &&
    chapterOf(c.code) === identify.family_chapter;

  const identityTokens =
    identify.kind === 'clean_product' ? identify.identity_tokens : [];
  const identityOverlap = countTokenOverlaps(
    identityTokens,
    c.description_en,
    c.description_ar,
  );

  const armBoost = ARM_BOOSTS[c.source_arm] ?? 0;

  return {
    rrf_score: c.rrf_score,
    chapter_agreement: chapterAgreement,
    identity_token_overlap_count: identityOverlap,
    arm_boost: armBoost,
  };
}

function computeScore(features: RerankFeatures): number {
  let s = features.rrf_score;
  if (features.chapter_agreement) s += CHAPTER_AGREEMENT_BOOST;
  s += Math.min(
    features.identity_token_overlap_count * IDENTITY_TOKEN_OVERLAP_PER_MATCH,
    IDENTITY_TOKEN_OVERLAP_MAX,
  );
  s += features.arm_boost;
  return s;
}

/**
 * Rerank the deduped candidate set, return top RERANK_CAP.
 *
 * Pure function. No I/O. Same inputs → same output.
 */
export function rerank(
  candidates: ScoredCandidate[],
  identify: IdentifyResult,
  cap: number = RERANK_CAP,
): RerankedCandidate[] {
  if (candidates.length === 0) return [];

  const scored: RerankedCandidate[] = candidates.map((c) => {
    const features = extractFeatures(c, identify);
    return {
      ...c,
      rerank_score: computeScore(features),
      rerank_features: features,
    };
  });

  scored.sort((a, b) => b.rerank_score - a.rerank_score);
  return scored.slice(0, cap);
}
