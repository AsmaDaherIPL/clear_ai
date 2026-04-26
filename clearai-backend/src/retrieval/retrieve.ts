/**
 * Hybrid retrieval: pgvector cosine + tsvector BM25 + pg_trgm fuzzy → RRF fused.
 *
 * Returns ranked candidates with a *fused* score in [0, 1] derived from RRF rank
 * inverses. The score is comparable across queries within the same endpoint
 * (per-endpoint thresholds in setup_meta).
 */
import { getPool } from '../db/client.js';
import { embedQuery } from '../embeddings/embedder.js';

export interface Candidate {
  code: string;
  description_en: string | null;
  description_ar: string | null;
  parent10: string;
  vec_rank: number | null;
  bm25_rank: number | null;
  trgm_rank: number | null;
  vec_score: number | null;
  bm25_score: number | null;
  trgm_score: number | null;
  /** Fused RRF score, normalised to [0,1] across the candidate set. */
  rrf_score: number;
}

interface RetrieveOpts {
  /** Restrict to rows whose `parent10` starts with this prefix (used by /expand). */
  prefixFilter?: string;
  /** Restrict to leaves only (12-digit rows). Default true for /describe and /expand. */
  leavesOnly?: boolean;
  /** Soft bias prefix from digit normalization — boosts scoring for matching rows. */
  prefixBias?: string | null;
  /** Total candidates to return after fusion. */
  topK?: number;
  /** RRF constant K (defaults to 60 per literature, override via setup_meta). */
  rrfK?: number;
  /** Per-arm fetch size before fusion. */
  perArmK?: number;
}

const PREFIX_BIAS_BOOST = 0.05; // additive on RRF score for matching rows

export async function retrieveCandidates(
  query: string,
  opts: RetrieveOpts = {}
): Promise<Candidate[]> {
  const {
    prefixFilter,
    leavesOnly = true,
    prefixBias,
    topK = 20,
    rrfK = 60,
    perArmK = 50,
  } = opts;

  const pool = getPool();
  const queryVec = await embedQuery(query);

  const filterClauses: string[] = [];
  const filterParams: unknown[] = [];
  let pIdx = 1;

  // We bind query-arm-specific params inline so each arm can use the same filter base.
  // The placeholder offset increments as we add params.
  const buildFilters = (offset: number): { sql: string; params: unknown[] } => {
    const parts: string[] = [];
    const params: unknown[] = [];
    let p = offset;
    if (leavesOnly) parts.push(`is_leaf = true`);
    if (prefixFilter) {
      parts.push(`parent10 LIKE $${p++}`);
      params.push(`${prefixFilter}%`);
    }
    return {
      sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '',
      params,
    };
  };
  // Suppress unused-var warnings until we need the closures inline below
  void filterClauses;
  void filterParams;
  void pIdx;

  // --- Vector arm (cosine distance via <=> ; lower = closer) ---
  const vecVal = `[${queryVec.join(',')}]`;
  const vecFilters = buildFilters(2); // $1 = vec, $2... = filter params
  const vecSql = `
    SELECT code, description_en, description_ar, parent10,
           1 - (embedding <=> $1::vector) AS score
    FROM hs_codes
    ${vecFilters.sql}
    ORDER BY embedding <=> $1::vector
    LIMIT ${perArmK}
  `;
  const vecRows = (
    await pool.query<{
      code: string;
      description_en: string | null;
      description_ar: string | null;
      parent10: string;
      score: number;
    }>(vecSql, [vecVal, ...vecFilters.params])
  ).rows;

  // --- BM25 arm (tsvector via plainto_tsquery; both EN and AR) ---
  const bm25Filters = buildFilters(2);
  const bm25Sql = `
    SELECT code, description_en, description_ar, parent10,
           GREATEST(
             ts_rank_cd(tsv_en, plainto_tsquery('english', $1)),
             ts_rank_cd(tsv_ar, plainto_tsquery('simple',  $1))
           ) AS score
    FROM hs_codes
    ${bm25Filters.sql}
    ORDER BY score DESC NULLS LAST
    LIMIT ${perArmK}
  `;
  const bm25Rows = (
    await pool.query<{
      code: string;
      description_en: string | null;
      description_ar: string | null;
      parent10: string;
      score: number;
    }>(bm25Sql, [query, ...bm25Filters.params])
  ).rows;

  // --- Trigram arm (pg_trgm similarity over EN OR AR) ---
  const trgmFilters = buildFilters(2);
  const trgmSql = `
    SELECT code, description_en, description_ar, parent10,
           GREATEST(
             similarity(coalesce(description_en, ''), $1),
             similarity(coalesce(description_ar, ''), $1)
           ) AS score
    FROM hs_codes
    ${trgmFilters.sql}
    ORDER BY score DESC
    LIMIT ${perArmK}
  `;
  const trgmRows = (
    await pool.query<{
      code: string;
      description_en: string | null;
      description_ar: string | null;
      parent10: string;
      score: number;
    }>(trgmSql, [query, ...trgmFilters.params])
  ).rows;

  // --- RRF fusion ---
  // For each arm, rank starts at 1. RRF contribution = 1 / (K + rank).
  const map = new Map<string, Candidate>();
  function ensure(code: string, desc_en: string | null, desc_ar: string | null, parent10: string): Candidate {
    let c = map.get(code);
    if (!c) {
      c = {
        code,
        description_en: desc_en,
        description_ar: desc_ar,
        parent10,
        vec_rank: null,
        bm25_rank: null,
        trgm_rank: null,
        vec_score: null,
        bm25_score: null,
        trgm_score: null,
        rrf_score: 0,
      };
      map.set(code, c);
    }
    return c;
  }

  vecRows.forEach((r, i) => {
    const c = ensure(r.code, r.description_en, r.description_ar, r.parent10);
    c.vec_rank = i + 1;
    c.vec_score = r.score;
    c.rrf_score += 1 / (rrfK + (i + 1));
  });
  bm25Rows.forEach((r, i) => {
    const c = ensure(r.code, r.description_en, r.description_ar, r.parent10);
    c.bm25_rank = i + 1;
    c.bm25_score = r.score;
    c.rrf_score += 1 / (rrfK + (i + 1));
  });
  trgmRows.forEach((r, i) => {
    const c = ensure(r.code, r.description_en, r.description_ar, r.parent10);
    c.trgm_rank = i + 1;
    c.trgm_score = r.score;
    c.rrf_score += 1 / (rrfK + (i + 1));
  });

  // Apply soft prefix bias (digit normalization)
  if (prefixBias) {
    for (const c of map.values()) {
      if (c.code.startsWith(prefixBias)) {
        c.rrf_score += PREFIX_BIAS_BOOST;
      }
    }
  }

  // Normalise: divide by max so top1 is in (0,1].
  const all = Array.from(map.values()).sort((a, b) => b.rrf_score - a.rrf_score);
  if (all.length > 0) {
    const maxScore = all[0]!.rrf_score || 1;
    for (const c of all) c.rrf_score = c.rrf_score / maxScore;
  }
  return all.slice(0, topK);
}
