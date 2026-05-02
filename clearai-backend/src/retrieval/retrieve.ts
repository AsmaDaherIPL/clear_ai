/**
 * Hybrid retrieval — 2-stage recall+rerank with RRF fusion.
 *
 * Pipeline:
 *
 *   STAGE 1 — RECALL (single arm: pgvector cosine)
 *     Pull RECALL_K (default 40) semantically-nearest rows from
 *     zatca_hs_code_search using HNSW cosine over the 384-dim e5 embedding.
 *     This is the recall stage — wide net, semantic similarity, no lexical
 *     constraints. Optional chapterHint constrains to 1-3 HS-2 chapters.
 *
 *   STAGE 2 — RERANK (BM25 + trigram, scoped to the recalled pool)
 *     For the same 40 codes from Stage 1, score them via:
 *       • bm25_score = ts_rank_cd over tsv_en / tsv_ar (deduplicated bag)
 *       • trgm_score = pg_trgm similarity over tsv_input_en / tsv_input_ar
 *     Then RRF-fuse with the Stage-1 vector ranks.
 *     Trigram contributes with a high RRF K (trgmRrfK = 200) so its
 *     influence is weak — it acts as a tertiary tie-break, not a primary
 *     signal. BM25 and vector use the standard rrfK (60).
 *     Return top RERANK_K (default 12) to the picker.
 *
 * KEY PROPERTY (vs the previous 3-arm parallel design):
 *   BM25 and trigram NEVER see the full catalog. They only score within the
 *   40-row pool the vector arm semantically pre-selected. This eliminates
 *   cross-domain contamination — "high heels" can't pull "high speed steel"
 *   into the candidate set because steel rods aren't in the 40 vector
 *   neighbours of "high heels".
 *
 * Storage (ADR-0025 split-catalog):
 *   • zatca_hs_code_search holds embedding, tsv_en/ar, tsv_input_en/ar
 *   • zatca_hs_codes is JOINed for the verbatim description columns +
 *     the is_deleted source-of-truth filter
 *
 * Failure mode: Stage 2 SQL failures degrade to vector-only ranking
 * (BM25 contributes nothing, trigram contributes nothing) — the picker
 * still gets candidates, just with weaker tie-breaks.
 */
import { getPool } from '../db/client.js';
import { embedQuery } from '../embeddings/embedder.js';

export interface Candidate {
  code: string;
  description_en: string | null;
  description_ar: string | null;
  parent10: string;
  /** Stage-1 rank (1-based), or null if missed by vector recall (impossible — every Candidate IS a vector hit). */
  vec_rank: number | null;
  /** Stage-2 BM25 rank (1-based, within the recalled pool), or null if BM25 produced 0 score. */
  bm25_rank: number | null;
  /** Stage-2 trigram rank (1-based, within the recalled pool), or null if trigram produced 0 score. */
  trgm_rank: number | null;
  vec_score: number | null;
  bm25_score: number | null;
  trgm_score: number | null;
  /** Fused RRF score, normalised to [0,1] across the candidate set. */
  rrf_score: number;
}

interface RetrieveOpts {
  /**
   * Restrict Stage-1 recall to rows whose `code` starts with this prefix.
   * e.g. '6402' filters to chapter 64, heading 02. Used by the expand
   * route's branch enumeration.
   */
  prefixFilter?: string;
  /**
   * Chapter hint from the chapter-hint preprocess module (commit 2).
   * When `confidence >= 0.80`, the listed chapters are used as a
   * Stage-1 prefix filter (`code LIKE 'XX%'` for each chapter, OR'd).
   * When confidence is below the threshold or the list is empty, no
   * filter applied — Stage 1 sees the full catalog.
   *
   * Chapter hint and prefixFilter are mutually exclusive in semantics —
   * if both are supplied, prefixFilter wins (it's a stricter caller-driven
   * constraint, e.g. expand-path branch enumeration).
   */
  chapterHint?: { likelyChapters: string[]; confidence: number } | null;
  /**
   * No-op since ADR-0008 (every catalog row is an HS-12 leaf). Preserved
   * for back-compat with existing callers; will be removed in a follow-up.
   */
  leavesOnly?: boolean;
  /** Soft bias prefix from digit normalization. Adds PREFIX_BIAS_BOOST to fused score. */
  prefixBias?: string | null;
  /** Total candidates returned after rerank. Default 12. */
  topK?: number;
  /** RRF constant K for vector + BM25 arms. Default 60. */
  rrfK?: number;
  /**
   * RRF constant K for the trigram arm. Default 200 — much higher than
   * rrfK so trigram contributes weakly, acting as a tertiary tie-break
   * rather than a primary signal.
   */
  trgmRrfK?: number;
  /** Stage-1 recall pool size. Default 40 — the vector arm pulls this many. */
  recallK?: number;
}

const PREFIX_BIAS_BOOST = 0.05;
/**
 * Hard threshold above which the chapter hint is converted into a
 * Stage-1 prefix filter. Below this, the hint is ignored — degrades
 * gracefully to today's unconstrained retrieval.
 */
const CHAPTER_HINT_HARD_FILTER_THRESHOLD = 0.80;

interface RawHit {
  code: string;
  description_en: string | null;
  description_ar: string | null;
  parent10: string;
  score: number;
}

interface RerankHit {
  code: string;
  bm25_score: number | null;
  trgm_score: number | null;
}

export async function retrieveCandidates(
  query: string,
  opts: RetrieveOpts = {},
): Promise<Candidate[]> {
  const {
    prefixFilter,
    chapterHint = null,
    prefixBias,
    topK = 12,
    rrfK = 60,
    trgmRrfK = 200,
    recallK = 40,
  } = opts;

  const pool = getPool();
  const queryVec = await embedQuery(query);
  const vecVal = `[${queryVec.join(',')}]`;

  // ──────────────────────────────────────────────────────────────────────
  // STAGE 1 — RECALL via pgvector cosine
  // ──────────────────────────────────────────────────────────────────────
  //
  // Filter shape:
  //   • Always: h.is_deleted = false  (deletion is single-source-of-truth on hs_codes)
  //   • If prefixFilter: s.code LIKE '<prefix>%'   (caller-driven, takes precedence)
  //   • Else if chapterHint with confidence ≥ 0.80: substring(s.code, 1, 2) = ANY($N)
  //   • Else no extra filter
  //
  // Parameter slot 1 is reserved for the query vector, so all params live at $2+.
  const stage1Filters: string[] = ['h.is_deleted = false'];
  const stage1Params: unknown[] = [];
  let nextParam = 2;

  if (prefixFilter) {
    stage1Filters.push(`s.code LIKE $${nextParam++}`);
    stage1Params.push(`${prefixFilter}%`);
  } else if (
    chapterHint &&
    chapterHint.likelyChapters.length > 0 &&
    chapterHint.confidence >= CHAPTER_HINT_HARD_FILTER_THRESHOLD
  ) {
    stage1Filters.push(`substring(s.code, 1, 2) = ANY($${nextParam++}::text[])`);
    stage1Params.push(chapterHint.likelyChapters);
  }

  const stage1Sql = `
    SELECT s.code,
           h.description_en,
           h.description_ar,
           substring(s.code, 1, 10) AS parent10,
           1 - (s.embedding <=> $1::vector) AS score
      FROM zatca_hs_code_search s
      JOIN zatca_hs_codes h ON h.code = s.code
     WHERE ${stage1Filters.join(' AND ')}
     ORDER BY s.embedding <=> $1::vector
     LIMIT ${recallK}
  `;
  const stage1Rows = (
    await pool.query<RawHit>(stage1Sql, [vecVal, ...stage1Params])
  ).rows;

  // Empty Stage-1 → return empty. Caller (Evidence Gate) handles this
  // as "invalid_prefix" / "weak_retrieval" downstream.
  if (stage1Rows.length === 0) return [];

  const recalledCodes = stage1Rows.map((r) => r.code);

  // ──────────────────────────────────────────────────────────────────────
  // STAGE 2 — RERANK (BM25 + trigram), scoped to recalled pool only
  // ──────────────────────────────────────────────────────────────────────
  //
  // We score every recalled row on both BM25 and trigram. Rows the LLM
  // tokeniser doesn't match get score 0 (and rank null in the result
  // shape). Rows are returned sorted by combined-rerank-then-vector for
  // stability, but we use the per-arm ranks separately for RRF fusion below.
  //
  // Two scores in one query (PG can compute both in a single seq scan
  // over the small recalled pool — much faster than two round-trips).
  // For BM25, we still need an arity check: tsv_en and tsv_ar both set
  // by the trigger from tsv_input_en/ar. Same for trigram on tsv_input_*.
  let stage2Rows: RerankHit[] = [];
  try {
    const stage2Sql = `
      SELECT s.code,
             GREATEST(
               ts_rank_cd(s.tsv_en, plainto_tsquery('english', $2)),
               ts_rank_cd(s.tsv_ar, plainto_tsquery('simple',  $2))
             ) AS bm25_score,
             GREATEST(
               similarity(coalesce(s.tsv_input_en, ''), $2),
               similarity(coalesce(s.tsv_input_ar, ''), $2)
             ) AS trgm_score
        FROM zatca_hs_code_search s
       WHERE s.code = ANY($1::char(12)[])
    `;
    const r = await pool.query<{
      code: string;
      bm25_score: string | number | null;
      trgm_score: string | number | null;
    }>(stage2Sql, [recalledCodes, query]);
    stage2Rows = r.rows.map((row) => ({
      code: row.code,
      bm25_score:
        row.bm25_score === null
          ? null
          : Number(row.bm25_score),
      trgm_score:
        row.trgm_score === null
          ? null
          : Number(row.trgm_score),
    }));
  } catch {
    // Stage-2 failure → degrade to vector-only ranking. The picker still
    // gets candidates; the audit log will show stage2_failed externally
    // if the caller logs it. Don't crash the request.
    stage2Rows = recalledCodes.map((code) => ({ code, bm25_score: null, trgm_score: null }));
  }

  const rerankByCode = new Map(stage2Rows.map((r) => [r.code, r]));

  // ──────────────────────────────────────────────────────────────────────
  // RRF FUSION
  // ──────────────────────────────────────────────────────────────────────
  //
  // For each recalled code, contribute up to three RRF terms:
  //   vec   contribution = 1 / (rrfK    + vec_rank)         — always present
  //   bm25  contribution = 1 / (rrfK    + bm25_rank)        — only if bm25 > 0
  //   trgm  contribution = 1 / (trgmRrfK + trgm_rank)       — only if trgm > 0
  //
  // BM25 + trigram ranks are computed within the recalled pool, sorted
  // descending by score. Rows with score 0 get null rank → no contribution
  // (RRF gracefully handles missing arms).

  // Sort recalled codes by their BM25 / trigram scores to assign ranks.
  const bm25Sorted = [...stage2Rows]
    .filter((r) => r.bm25_score !== null && r.bm25_score > 0)
    .sort((a, b) => (b.bm25_score ?? 0) - (a.bm25_score ?? 0));
  const trgmSorted = [...stage2Rows]
    .filter((r) => r.trgm_score !== null && r.trgm_score > 0)
    .sort((a, b) => (b.trgm_score ?? 0) - (a.trgm_score ?? 0));
  const bm25RankByCode = new Map<string, number>(bm25Sorted.map((r, i) => [r.code, i + 1]));
  const trgmRankByCode = new Map<string, number>(trgmSorted.map((r, i) => [r.code, i + 1]));

  const candidates: Candidate[] = stage1Rows.map((row, i) => {
    const vecRank = i + 1;
    const rerankRow = rerankByCode.get(row.code);
    const bm25Rank = bm25RankByCode.get(row.code) ?? null;
    const trgmRank = trgmRankByCode.get(row.code) ?? null;

    let rrf = 1 / (rrfK + vecRank);
    if (bm25Rank !== null) rrf += 1 / (rrfK + bm25Rank);
    if (trgmRank !== null) rrf += 1 / (trgmRrfK + trgmRank);

    return {
      code: row.code,
      description_en: row.description_en,
      description_ar: row.description_ar,
      parent10: row.parent10,
      vec_rank: vecRank,
      bm25_rank: bm25Rank,
      trgm_rank: trgmRank,
      vec_score: row.score,
      bm25_score: rerankRow?.bm25_score ?? null,
      trgm_score: rerankRow?.trgm_score ?? null,
      rrf_score: rrf,
    };
  });

  // Apply soft prefix bias if requested.
  if (prefixBias) {
    for (const c of candidates) {
      if (c.code.startsWith(prefixBias)) {
        c.rrf_score += PREFIX_BIAS_BOOST;
      }
    }
  }

  // Normalise so top1 is in (0, 1] for callers that compare against
  // MIN_SCORE thresholds.
  candidates.sort((a, b) => b.rrf_score - a.rrf_score);
  const maxScore = candidates[0]?.rrf_score || 1;
  for (const c of candidates) c.rrf_score = c.rrf_score / maxScore;

  return candidates.slice(0, topK);
}
