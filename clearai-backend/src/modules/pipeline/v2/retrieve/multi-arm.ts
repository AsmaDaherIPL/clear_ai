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
import { embedQuery } from '../../../../inference/embeddings/embedder.js';
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
  /**
   * PR4: precomputed query vector for the main query string. Reused
   * across all arms that retrieve against the canonical query (merchant_
   * prefix, family_chapter, unconstrained). The lexical_tokens arm uses
   * a different query (tokens joined) and embeds its own.
   */
  precomputedQueryVec: number[] | undefined,
): Promise<ScoredCandidate[]> {
  // escalate arms never retrieve — they short-circuit upstream.
  if (arm.kind === 'escalate') return [];

  if (arm.kind === 'merchant_prefix') {
    const candidates = await retrieveCandidates(query, {
      prefixFilter: arm.prefix,
      topK: PER_ARM_TOP_K,
      precomputedQueryVec,
    });
    return candidates.map((c) => tagged(c, 'merchant_prefix'));
  }

  if (arm.kind === 'family_chapter') {
    const candidates = await retrieveCandidates(query, {
      prefixFilter: arm.chapter,
      topK: PER_ARM_TOP_K,
      precomputedQueryVec,
    });
    return candidates.map((c) => tagged(c, 'family_chapter'));
  }

  if (arm.kind === 'unconstrained') {
    const candidates = await retrieveCandidates(query, {
      topK: PER_ARM_TOP_K,
      precomputedQueryVec,
    });
    return candidates.map((c) => tagged(c, 'unconstrained'));
  }

  if (arm.kind === 'lexical_tokens') {
    // Lexical arm query = tokens joined by space. Different query string
    // → different embedding → embed on demand inside retrieveCandidates.
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
  /** PR4: list of arm kinds actually scheduled (after escalate filter). */
  arms_fired: string[];
  /** PR4: number of scheduled arms that returned zero candidates. */
  arms_zero_result_count: number;
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

  // PR4: embed the main query ONCE here and pass the vector through to
  // every arm that uses it (merchant_prefix, family_chapter,
  // unconstrained). Previously each arm called embedQuery independently
  // — typical 3-arm row paid 3× the embedder cost. The lexical_tokens
  // arm uses a different query string, so it still embeds on demand.
  //
  // Skip the precompute when no arm needs it (only lexical_tokens
  // and/or escalate arms are scheduled). The embedder may be slow or
  // hiccup; don't pay the round-trip if no arm will use it.
  const needsMainQueryVec = arms.some(
    (a) =>
      a.kind === 'merchant_prefix' ||
      a.kind === 'family_chapter' ||
      a.kind === 'unconstrained',
  );
  let mainQueryVec: number[] | undefined;
  if (needsMainQueryVec && query.trim().length > 0) {
    try {
      mainQueryVec = await embedQuery(query);
    } catch (err) {
      // Embedder failed — let each arm fall back to its own embed call
      // (which will fail in the same way, but at least the arm-level
      // error path is exercised consistently). Log so we know.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[multi-arm] main-query embed failed; arms will retry independently: ${msg.slice(0, 300)}`,
      );
      mainQueryVec = undefined;
    }
  }

  // allSettled (not Promise.all): the docstring above promises arms that
  // fail return empty arrays. With raw Promise.all, a single arm
  // rejection discards every arm's work and the row 500s. We want graceful
  // degradation — a transient DB error on one arm should leave the
  // others' candidates intact and let the picker work with a smaller pool.
  const settled = await Promise.allSettled(
    arms.map((arm) => runArm(arm, query, mainQueryVec)),
  );

  const per_arm_counts: Record<string, number> = {};
  const flat: ScoredCandidate[] = [];
  for (let i = 0; i < arms.length; i++) {
    const arm = arms[i]!;
    const result = settled[i]!;
    const armKey = arm.kind;
    if (result.status === 'fulfilled') {
      per_arm_counts[armKey] = (per_arm_counts[armKey] ?? 0) + result.value.length;
      flat.push(...result.value);
    } else {
      per_arm_counts[armKey] = per_arm_counts[armKey] ?? 0;
      const reason =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      console.warn(
        `[multi-arm] arm '${armKey}' rejected: ${reason} — treating as 0 candidates`,
      );
    }
  }

  // PR4 telemetry. arms_fired excludes 'escalate' arms (which never
  // retrieve). arms_zero_result_count is how many of those that DID
  // run returned zero candidates — distinct from "the arm failed."
  const arms_fired = arms.filter((a) => a.kind !== 'escalate').map((a) => a.kind);
  const arms_zero_result_count = arms_fired.filter(
    (kind) => (per_arm_counts[kind] ?? 0) === 0,
  ).length;

  return { candidates: flat, per_arm_counts, arms_fired, arms_zero_result_count };
}
