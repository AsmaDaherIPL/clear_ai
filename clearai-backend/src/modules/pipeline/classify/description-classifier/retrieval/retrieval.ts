/**
 * Track A / Hybrid retrieval — embedder + BM25 + trigram, no LLM.
 *
 * Returns up to RERANK_K (12) ranked candidates with RRF scores.
 * Delegates entirely to inference/retrieval/retrieve.ts.
 */
import { retrieveCandidates } from '../../../../../inference/retrieval/retrieve.js';
import type { Candidate } from '../../../../../inference/retrieval/retrieve.js';

export type { Candidate };

export interface RetrievalOutput {
  candidates: Candidate[];
  latency_ms: number;
  /**
   * True iff a family_chapter hint widened the candidate pool with codes
   * that weren't in the unconstrained retrieval. Surfaced so the trace
   * can show when the web researcher's hint changed the picker's input.
   */
  family_widened: boolean;
}

export interface RetrievalOpts {
  /**
   * 2-digit HS chapter hint (PR3 / Layer 5). When set, retrieval runs a
   * second pass scoped to that chapter and merges any non-duplicate
   * candidates into the main pool. Used when the web researcher
   * identified the product family but the unconstrained retrieval
   * missed it (e.g. "Pine Wood Cat Litter" → Ch 44, but the embedder
   * surfaced mineral Ch 25 candidates).
   */
  family_chapter?: string;
}

export async function runRetrieval(
  effective_description: string,
  opts: RetrievalOpts = {},
): Promise<RetrievalOutput> {
  const start = Date.now();
  const unconstrained = await retrieveCandidates(effective_description);

  // Family-chapter widening: only when (a) a hint is given AND (b) none of
  // the unconstrained candidates already sit in that chapter. Avoids a
  // wasted query on the happy path.
  let family_widened = false;
  let merged = unconstrained;
  if (opts.family_chapter && /^\d{2}$/.test(opts.family_chapter)) {
    const chapter = opts.family_chapter;
    const alreadyHasChapter = unconstrained.some((c) => c.code.startsWith(chapter));
    if (!alreadyHasChapter) {
      const widening = await retrieveCandidates(effective_description, {
        prefixFilter: chapter,
        topK: 4,
      });
      if (widening.length > 0) {
        family_widened = true;
        // Append, keeping the unconstrained candidates first so the
        // embedder's primary signal still dominates the picker's
        // attention. Dedup by code defensively.
        const seen = new Set(unconstrained.map((c) => c.code));
        merged = [...unconstrained];
        for (const c of widening) {
          if (!seen.has(c.code)) {
            merged.push(c);
            seen.add(c.code);
          }
        }
      }
    }
  }

  return {
    candidates: merged,
    latency_ms: Date.now() - start,
    family_widened,
  };
}
