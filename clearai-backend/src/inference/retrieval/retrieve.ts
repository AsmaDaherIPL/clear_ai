/**
 * Hybrid retrieval — 2-stage recall+rerank with RRF fusion.
 *
 * Pipeline:
 *
 *   STAGE 1 — RECALL (single arm: pgvector cosine)
 *     Pull RECALL_K (default 40) semantically-nearest rows from
 *     zatca_hs_code_search using HNSW cosine over the 384-dim e5 embedding.
 *     This is the recall stage — wide net, semantic similarity, no lexical
 *     constraints. The chapter-hint LLM pre-step that used to optionally
 *     constrain this stage was removed in 0036 — measurements showed the
 *     2-stage rewrite (this module) already structurally eliminates the
 *     cross-chapter noise the hint was designed to fix, and the hint's
 *     catastrophic-wrong-prediction failure mode (locking the picker out
 *     of the right chapter) outweighed its marginal-case wins.
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
import { getPool } from '../../db/client.js';
import { embedQuery } from '../embeddings/embedder.js';

export interface Candidate {
  code: string;
  description_en: string | null;
  description_ar: string | null;
  parent10: string;
  /**
   * Breadcrumb path to this leaf, joined by ", " (and "، " in AR), from
   * zatca_hs_code_display.path_en. Aligned 1:1 with `path_codes`.
   * The last segment after the final separator is the leaf's own label.
   * Element [0] is the heading title (XXXX00000000) when this row has
   * a heading ancestor; for rows that ARE the heading the array contains
   * only the leaf label. Empty string if the display row is missing
   * (defensive — should never happen post-ingest).
   */
  path_en: string;
  /** Same shape as path_en, Arabic. Empty string if missing. */
  path_ar: string;
  /** Aligned codes for path_en/path_ar. e.g. ["150900000000","150910000000","150910100000"]. */
  path_codes: string[];
  /** Stage-1 rank (1-based), or null if missed by vector recall (impossible — every Candidate IS a vector hit). */
  vec_rank: number | null;
  /** Stage-2 BM25 rank (1-based, within the recalled pool), or null if BM25 produced 0 score. */
  bm25_rank: number | null;
  /** Stage-2 trigram rank (1-based, within the recalled pool), or null if trigram produced 0 score. */
  trgm_rank: number | null;
  vec_score: number | null;
  bm25_score: number | null;
  trgm_score: number | null;
  /**
   * Fused weighted-RRF score. Raw, not normalised — top1 for a clean two-arm
   * hit at default weights (vec=1.0, bm25=1.5) is roughly:
   *   1.0/(60+1) + 1.5/(60+1) ≈ 0.041
   * Vector-only top1 ≈ 0.016. Threshold gates compare against these raw values.
   */
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
  /**
   * Per-arm weights applied to the rank-based RRF contribution. Per Elastic 8.16
   * weighted-RRF semantics: each arm's term becomes weight * 1/(K + rank).
   * Defaults reflect domain priors for HS-code retrieval — BM25 over the
   * bilingual catalog is the most reliable signal for technical product
   * terminology, vector recall is solid but the e5-small model under-clusters
   * jargon, and trigram is a weak tertiary tie-break.
   */
  vecWeight?: number;
  bm25Weight?: number;
  trgmWeight?: number;
}

// Soft tie-break for prefix matches. Sized for raw RRF (~0.04 at top1):
// large enough to flip near-ties, small enough not to outweigh a clean
// two-arm rank-1 hit on a different prefix.
const PREFIX_BIAS_BOOST = 0.001;
const DEFAULT_VEC_WEIGHT = 1.0;
const DEFAULT_BM25_WEIGHT = 1.5;
const DEFAULT_TRGM_WEIGHT = 0.5;

interface RawHit {
  code: string;
  description_en: string | null;
  description_ar: string | null;
  parent10: string;
  path_en: string | null;
  path_ar: string | null;
  path_codes: string[] | null;
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
    prefixBias,
    topK = 12,
    rrfK = 60,
    trgmRrfK = 200,
    recallK = 40,
    vecWeight = DEFAULT_VEC_WEIGHT,
    bm25Weight = DEFAULT_BM25_WEIGHT,
    trgmWeight = DEFAULT_TRGM_WEIGHT,
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
  //   • If prefixFilter: s.code LIKE '<prefix>%'   (caller-driven, takes precedence —
  //     used by the expand route's branch enumeration)
  //   • Else: no extra filter — Stage 2 BM25/trigram refinement within the recalled
  //     pool already prevents cross-chapter pollution.
  //
  // Parameter slot 1 is reserved for the query vector, so all params live at $2+.
  const stage1Filters: string[] = ['h.is_deleted = false'];
  const stage1Params: unknown[] = [];
  let nextParam = 2;

  if (prefixFilter) {
    stage1Filters.push(`s.code LIKE $${nextParam++}`);
    stage1Params.push(`${prefixFilter}%`);
  }

  // LEFT JOIN zatca_hs_code_display — every leaf SHOULD have a display row
  // post-ingest, but defensive LEFT JOIN keeps retrieval working if the
  // derived table is partially out of date. Missing rows fall through with
  // null path_en/path_ar/path_codes, which buildUser() treats as "no path
  // available" (mode 0 behaviour for that single candidate, regardless of
  // PICKER_PATH_MODE).
  const stage1Sql = `
    SELECT s.code,
           h.description_en,
           h.description_ar,
           substring(s.code, 1, 10) AS parent10,
           d.path_en,
           d.path_ar,
           d.path_codes,
           1 - (s.embedding <=> $1::vector) AS score
      FROM zatca_hs_code_search s
      JOIN zatca_hs_codes h ON h.code = s.code
 LEFT JOIN zatca_hs_code_display d ON d.code = s.code
     WHERE ${stage1Filters.join(' AND ')}
     ORDER BY s.embedding <=> $1::vector, s.code
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
  } catch (err) {
    // Stage-2 failure → degrade to vector-only ranking. The picker still
    // gets candidates; don't crash the request.
    //
    // 2026-05-19 (TASKS R11): previously this catch swallowed the error
    // silently — no log, no metric, no signal anywhere that BM25/trigram
    // ranking was missing. Silent retrieval-quality regressions that
    // were impossible to attribute. Now we log a structured warning so
    // operators can see the degradation in container logs.
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.warn(
      `[retrieve] stage-2 BM25/trigram failed, falling back to vector-only ranking; ${recalledCodes.length} candidates affected: ${msg.slice(0, 300)}`,
    );
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
  // Deterministic tie-break: when two rows share a score, fall back to
  // lexicographic order on code. Without this, V8's sort stability +
  // Postgres row order decide ranks across runs of identical input,
  // which downstream produces non-reproducible RRF scores and rerank
  // pools. Apply the same tiebreak to every sort below.
  const bm25Sorted = [...stage2Rows]
    .filter((r) => r.bm25_score !== null && r.bm25_score > 0)
    .sort(
      (a, b) =>
        (b.bm25_score ?? 0) - (a.bm25_score ?? 0) || a.code.localeCompare(b.code),
    );
  const trgmSorted = [...stage2Rows]
    .filter((r) => r.trgm_score !== null && r.trgm_score > 0)
    .sort(
      (a, b) =>
        (b.trgm_score ?? 0) - (a.trgm_score ?? 0) || a.code.localeCompare(b.code),
    );
  const bm25RankByCode = new Map<string, number>(bm25Sorted.map((r, i) => [r.code, i + 1]));
  const trgmRankByCode = new Map<string, number>(trgmSorted.map((r, i) => [r.code, i + 1]));

  const candidates: Candidate[] = stage1Rows.map((row, i) => {
    const vecRank = i + 1;
    const rerankRow = rerankByCode.get(row.code);
    const bm25Rank = bm25RankByCode.get(row.code) ?? null;
    const trgmRank = trgmRankByCode.get(row.code) ?? null;

    let rrf = vecWeight * (1 / (rrfK + vecRank));
    if (bm25Rank !== null) rrf += bm25Weight * (1 / (rrfK + bm25Rank));
    if (trgmRank !== null) rrf += trgmWeight * (1 / (trgmRrfK + trgmRank));

    return {
      code: row.code,
      description_en: row.description_en,
      description_ar: row.description_ar,
      parent10: row.parent10,
      path_en: row.path_en ?? '',
      path_ar: row.path_ar ?? '',
      path_codes: row.path_codes ?? [],
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

  // Return raw RRF scores (no max-normalisation). Aligns with Elastic / Azure
  // AI Search / OpenSearch reference implementations: dividing by max launders
  // weak retrieval into score=1.0 at top1 and breaks the threshold gate.
  candidates.sort(
    (a, b) => b.rrf_score - a.rrf_score || a.code.localeCompare(b.code),
  );

  return candidates.slice(0, topK);
}
