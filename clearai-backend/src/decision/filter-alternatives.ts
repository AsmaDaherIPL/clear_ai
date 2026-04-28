/**
 * Filter the user-facing alternatives list down from raw RRF retrieval to
 * "siblings a customs broker would actually want to compare against".
 *
 * Why this exists:
 *   RRF (vector + BM25 + trigram) is a fusion of *ranked* lists, normalised to
 *   [0, 1] *within this query*. Once strong matches are exhausted, RRF still
 *   surfaces a long tail of weak hits and rescales them upward — so the user
 *   sees "Bathing headgear at 80%" or "Horses at 50%" listed as alternatives
 *   to wireless headphones, simply because those rows had a single trigram
 *   collision with the query and nothing better was left in the catalog.
 *   The picker (Sonnet) correctly throws these out when picking, but the
 *   alternatives surface is downstream of the picker and dumps the raw top-K.
 *
 * Two-rule filter (both AND'd):
 *   1. Absolute score floor: drop anything below `minScore`. RRF scores below
 *      this absolute threshold are noise regardless of relative rank.
 *   2. Chapter-coherence: same-chapter siblings survive on rule (1) alone.
 *      Cross-chapter candidates additionally must be *close to the top*
 *      retrieval score — `score >= topScore * strongRatio` (default 0.95).
 *      This is more robust than a fixed cross-chapter score bar: it lets a
 *      genuine near-tie through (wired vs wireless headphones both score
 *      ~1.0) while killing rows that just happened to share a token with
 *      the query (bathing headgear shares "head*" but scores meaningfully
 *      below the top).
 *
 * The chosen code itself is always pinned to the top regardless of these
 * filters — even if it scored below the floor in pure RRF terms, the
 * picker chose it for non-lexical reasons and the user must see what was
 * picked. Filtering only applies to the *other* siblings.
 */
import type { Candidate } from '../retrieval/retrieve.js';

export interface FilterAlternativesOpts {
  /** Code that was picked (or best-effort'd). Always rendered, never filtered. */
  chosenCode: string | null;
  /** Absolute floor: candidates with rrf_score below this are dropped. */
  minScore: number;
  /**
   * Cross-chapter ratio against the top retrieval score (e.g. 0.95 means
   * cross-chapter candidates must score at least 95% of the top score).
   */
  strongRatio: number;
  /** Hard cap on returned siblings (chosen + siblings). */
  maxShown: number;
}

function chapterOf(code: string): string {
  return (code || '').slice(0, 2);
}

export function filterAlternatives(
  candidates: Candidate[],
  opts: FilterAlternativesOpts,
): Candidate[] {
  const { chosenCode, minScore, strongRatio, maxShown } = opts;
  const chosenChapter = chosenCode ? chapterOf(chosenCode) : null;

  // Top score across the WHOLE retrieval set (not just non-chosen rows). Used
  // as the reference for the cross-chapter "near-tie" rule.
  const topScore = candidates.reduce((m, c) => (c.rrf_score > m ? c.rrf_score : m), 0);
  const crossChapterBar = topScore * strongRatio;

  // Pin the chosen row to the front (if present in retrieval).
  const chosen = chosenCode ? candidates.find((c) => c.code === chosenCode) : undefined;
  const others = candidates.filter((c) => c.code !== chosenCode);

  const kept = others.filter((c) => {
    if (c.rrf_score < minScore) return false;
    // No chosen code → no chapter coherence rule (e.g. degraded path).
    if (!chosenChapter) return true;
    if (chapterOf(c.code) === chosenChapter) return true;
    // Cross-chapter: only survives if its score is close to the top score
    // — a genuine near-tie, not just "above some absolute number".
    return c.rrf_score >= crossChapterBar;
  });

  const out: Candidate[] = [];
  if (chosen) out.push(chosen);
  for (const c of kept) {
    if (out.length >= maxShown) break;
    out.push(c);
  }
  return out;
}
