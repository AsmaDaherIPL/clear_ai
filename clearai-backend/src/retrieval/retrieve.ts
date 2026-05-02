/**
 * Hybrid retrieval: pgvector cosine + tsvector BM25 + pg_trgm fuzzy fused
 * with RRF. Returns candidates ranked by a normalised score in [0, 1].
 *
 * Storage (ADR-0025 split-catalog):
 *   • hs_code_search holds embedding/tsv/trgm columns + denormalised is_deleted
 *     flag for hot-path filtering. Asymmetric per-arm input:
 *       - vector arm reads `embedding` (built from path_en | path_ar)
 *       - BM25 arm reads `tsv_en` / `tsv_ar` (built from deduplicated tsv_input_*)
 *       - trigram arm reads `tsv_input_en` / `tsv_input_ar` directly
 *   • hs_codes is JOINed only to surface the verbatim description columns
 *     in the result shape (back-compat for callers).
 *   • leaves-only filter no longer applies — all 19,105 ZATCA rows are
 *     12-digit leaves post-ADR-0008. The `leavesOnly` option is preserved
 *     for callers but is now a no-op; a future commit can remove it.
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
  /** Restrict to rows whose `code` starts with this prefix (formerly `parent10` filter). */
  prefixFilter?: string;
  /**
   * No-op since ADR-0008 (every catalog row is an HS-12 leaf). Preserved
   * for back-compat with existing callers; will be removed in a follow-up.
   */
  leavesOnly?: boolean;
  /** Soft bias prefix from digit normalization. */
  prefixBias?: string | null;
  /** Total candidates returned after fusion. */
  topK?: number;
  /** RRF constant K. Default 60. */
  rrfK?: number;
  /** Per-arm fetch size before fusion. */
  perArmK?: number;
}

const PREFIX_BIAS_BOOST = 0.05;

interface RawHit {
  code: string;
  description_en: string | null;
  description_ar: string | null;
  parent10: string;
  score: number;
}

export async function retrieveCandidates(
  query: string,
  opts: RetrieveOpts = {},
): Promise<Candidate[]> {
  const {
    prefixFilter,
    prefixBias,
    topK = 20,
    rrfK = 60,
    perArmK = 50,
  } = opts;

  const pool = getPool();
  const queryVec = await embedQuery(query);

  // Common filter clauses live on hs_code_search (where is_deleted is the
  // denormalised flag, kept in sync by trigger from hs_codes). Prefix
  // filtering uses the code column itself — both sides are 12-char so
  // `code LIKE '6402%'` is exact and uses the PK index.
  const buildFilters = (offset: number): { sql: string; params: unknown[] } => {
    const parts: string[] = ['s.is_deleted = false'];
    const params: unknown[] = [];
    let p = offset;
    if (prefixFilter) {
      parts.push(`s.code LIKE $${p++}`);
      params.push(`${prefixFilter}%`);
    }
    return {
      sql: `WHERE ${parts.join(' AND ')}`,
      params,
    };
  };

  // Vector arm (cosine).
  const vecVal = `[${queryVec.join(',')}]`;
  const vecFilters = buildFilters(2);
  const vecSql = `
    SELECT s.code,
           h.description_en,
           h.description_ar,
           substring(s.code, 1, 10) AS parent10,
           1 - (s.embedding <=> $1::vector) AS score
      FROM hs_code_search s
      JOIN hs_codes h ON h.code = s.code
      ${vecFilters.sql}
    ORDER BY s.embedding <=> $1::vector
    LIMIT ${perArmK}
  `;
  const vecRows = (
    await pool.query<RawHit>(vecSql, [vecVal, ...vecFilters.params])
  ).rows;

  // BM25 arm — tsv_en / tsv_ar over the deduplicated token bag.
  const bm25Filters = buildFilters(2);
  const bm25Sql = `
    SELECT s.code,
           h.description_en,
           h.description_ar,
           substring(s.code, 1, 10) AS parent10,
           GREATEST(
             ts_rank_cd(s.tsv_en, plainto_tsquery('english', $1)),
             ts_rank_cd(s.tsv_ar, plainto_tsquery('simple',  $1))
           ) AS score
      FROM hs_code_search s
      JOIN hs_codes h ON h.code = s.code
      ${bm25Filters.sql}
    ORDER BY score DESC NULLS LAST
    LIMIT ${perArmK}
  `;
  const bm25Rows = (
    await pool.query<RawHit>(bm25Sql, [query, ...bm25Filters.params])
  ).rows;

  // Trigram arm — pg_trgm similarity over the same deduplicated text
  // (so the lexical and trigram arms see consistent input shape).
  const trgmFilters = buildFilters(2);
  const trgmSql = `
    SELECT s.code,
           h.description_en,
           h.description_ar,
           substring(s.code, 1, 10) AS parent10,
           GREATEST(
             similarity(coalesce(s.tsv_input_en, ''), $1),
             similarity(coalesce(s.tsv_input_ar, ''), $1)
           ) AS score
      FROM hs_code_search s
      JOIN hs_codes h ON h.code = s.code
      ${trgmFilters.sql}
    ORDER BY score DESC
    LIMIT ${perArmK}
  `;
  const trgmRows = (
    await pool.query<RawHit>(trgmSql, [query, ...trgmFilters.params])
  ).rows;

  // RRF fusion: contribution per arm = 1 / (K + rank).
  const map = new Map<string, Candidate>();
  function ensure(
    code: string,
    desc_en: string | null,
    desc_ar: string | null,
    parent10: string,
  ): Candidate {
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

  if (prefixBias) {
    for (const c of map.values()) {
      if (c.code.startsWith(prefixBias)) {
        c.rrf_score += PREFIX_BIAS_BOOST;
      }
    }
  }

  // Normalise so top1 is in (0,1].
  const all = Array.from(map.values()).sort((a, b) => b.rrf_score - a.rrf_score);
  if (all.length > 0) {
    const maxScore = all[0]!.rrf_score || 1;
    for (const c of all) c.rrf_score = c.rrf_score / maxScore;
  }
  return all.slice(0, topK);
}
