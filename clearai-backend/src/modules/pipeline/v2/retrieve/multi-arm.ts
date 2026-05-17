/**
 * Pipeline rewrite — Stage 5: multi-arm retrieval orchestration (PR 7).
 *
 * Given a ScopeSelection + query, fire each arm's retrieval in parallel
 * against the shared engine (src/inference/retrieval/retrieve.ts), then
 * collect the candidates with source_arm tags. Dedupe + reranking happen
 * downstream in this PR's union.ts module.
 *
 * Arms map to retrieval options:
 *
 *   merchant_prefix  → prefixFilter=arm.prefix, default weights
 *   family_chapter   → prefixFilter=arm.chapter (2-digit), default weights
 *   unconstrained    → no prefixFilter, default weights
 *   lexical_tokens   → no prefixFilter, query is identity_tokens joined,
 *                      vector weight reduced (lexical signal dominates)
 *
 * Each retrieveCandidates call is bounded to topK=12 per arm. Union
 * after dedupe is capped at 24 candidates (worst case: 3 arms × 12,
 * minus duplicates). The reranker (PR 8) trims to top 8.
 */
import {
  retrieveCandidates,
  type Candidate,
} from '../../../../inference/retrieval/retrieve.js';
import type { RetrievalArm, ScopeSelection, ScoredCandidate } from '../types.js';

/** Per-arm cap. Same as the legacy single-arm cap. */
const PER_ARM_TOP_K = 12;

/**
 * Lexical arm weights: vector still contributes (we want some semantic
 * fallback for typos / morphology) but BM25 dominates. This shifts
 * retrieval toward leaves whose description text literally contains the
 * identity tokens — exactly what we want for brand/ingredient/SKU lookups.
 *
 * Empirically picked; tunable via env later if needed.
 */
const LEXICAL_ARM_WEIGHTS = {
  vecWeight: 0.3,
  bm25Weight: 2.0,
  trgmWeight: 0.5,
};

/**
 * Convert a retrieval Candidate (legacy shape) into a v2 ScoredCandidate
 * with the source_arm tag. Other fields pass through.
 */
function tagged(
  c: Candidate,
  source_arm: ScoredCandidate['source_arm'],
): ScoredCandidate {
  return {
    code: c.code,
    description_en: c.description_en,
    description_ar: c.description_ar,
    // path_en/ar come from retrieval's join on zatca_hs_code_display;
    // we thread them through so the picker's annotated_candidates can
    // expose the full breadcrumb, not just the leaf label.
    path_en: c.path_en,
    path_ar: c.path_ar,
    rrf_score: c.rrf_score,
    bm25_score: c.bm25_score,
    vector_score: c.vec_score,
    trigram_score: c.trgm_score,
    source_arm,
  };
}

/**
 * Run a single retrieval arm. Returns an empty array on retrieval errors
 * (which propagate up as 0 candidates from this arm; other arms may
 * still produce results).
 *
 * `query` is the identify.canonical (+ identity_tokens for non-lexical
 * arms). Lexical arm receives the tokens-only query from the caller.
 */
async function runArm(
  arm: RetrievalArm,
  query: string,
): Promise<ScoredCandidate[]> {
  // escalate arms never retrieve — they short-circuit upstream.
  if (arm.kind === 'escalate') return [];

  if (arm.kind === 'merchant_prefix') {
    const candidates = await retrieveCandidates(query, {
      prefixFilter: arm.prefix,
      topK: PER_ARM_TOP_K,
    });
    return candidates.map((c) => tagged(c, 'merchant_prefix'));
  }

  if (arm.kind === 'family_chapter') {
    const candidates = await retrieveCandidates(query, {
      prefixFilter: arm.chapter,
      topK: PER_ARM_TOP_K,
    });
    return candidates.map((c) => tagged(c, 'family_chapter'));
  }

  if (arm.kind === 'unconstrained') {
    const candidates = await retrieveCandidates(query, {
      topK: PER_ARM_TOP_K,
    });
    return candidates.map((c) => tagged(c, 'unconstrained'));
  }

  if (arm.kind === 'lexical_tokens') {
    // Lexical arm query = tokens joined by space. Vector signal is
    // de-emphasised so BM25 + trigram dominate. No prefixFilter — we
    // want lexical anchors to surface their own chapter.
    const lexicalQuery = arm.tokens.join(' ').trim();
    if (lexicalQuery.length === 0) return [];
    const candidates = await retrieveCandidates(lexicalQuery, {
      topK: PER_ARM_TOP_K,
      ...LEXICAL_ARM_WEIGHTS,
    });
    return candidates.map((c) => tagged(c, 'lexical_tokens'));
  }

  // Exhaustiveness check (typescript would catch missing variant).
  const _exhaustive: never = arm;
  return _exhaustive;
}

export interface MultiArmRetrievalResult {
  candidates: ScoredCandidate[];
  /** Count of candidates returned by each arm before dedupe. */
  per_arm_counts: Record<string, number>;
}

/**
 * Run all arms in parallel, return tagged candidates ready for dedupe.
 *
 * Arms that fail (network, DB error) return empty arrays — the function
 * does not throw. The orchestrator can detect "all arms returned zero"
 * and escalate as no_candidates.
 */
export async function runMultiArmRetrieval(
  scope: ScopeSelection,
  query: string,
): Promise<MultiArmRetrievalResult> {
  const arms: RetrievalArm[] = [scope.primary, ...scope.secondaries];

  const armResults = await Promise.all(arms.map((arm) => runArm(arm, query)));

  const per_arm_counts: Record<string, number> = {};
  const flat: ScoredCandidate[] = [];
  for (let i = 0; i < arms.length; i++) {
    const arm = arms[i]!;
    const armCandidates = armResults[i]!;
    const armKey = arm.kind;
    per_arm_counts[armKey] = (per_arm_counts[armKey] ?? 0) + armCandidates.length;
    flat.push(...armCandidates);
  }

  return { candidates: flat, per_arm_counts };
}
