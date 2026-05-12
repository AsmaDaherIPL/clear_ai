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
}

export async function runRetrieval(effective_description: string): Promise<RetrievalOutput> {
  const start = Date.now();
  const candidates = await retrieveCandidates(effective_description);
  return {
    candidates,
    latency_ms: Date.now() - start,
  };
}
