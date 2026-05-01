/**
 * Filter alternatives shown to the user. Drops below-floor scores, then drops
 * cross-chapter rows unless they're close to the top score. Excludes the
 * chosen code (it ships at result.code).
 */
import type { Candidate } from '../retrieval/retrieve.js';

export interface FilterAlternativesOpts {
  /** Always excluded from the output; ships at result.code instead. */
  chosenCode: string | null;
  minScore: number;
  /** Cross-chapter rows must score at least topScore * strongRatio. */
  strongRatio: number;
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

  const topScore = candidates.reduce((m, c) => (c.rrf_score > m ? c.rrf_score : m), 0);
  const crossChapterBar = topScore * strongRatio;

  const others = candidates.filter((c) => c.code !== chosenCode);

  const kept = others.filter((c) => {
    if (c.rrf_score < minScore) return false;
    if (!chosenChapter) return true;
    if (chapterOf(c.code) === chosenChapter) return true;
    return c.rrf_score >= crossChapterBar;
  });

  const out: Candidate[] = [];
  for (const c of kept) {
    if (out.length >= maxShown) break;
    out.push(c);
  }
  return out;
}
