/**
 * Track A / Researcher — runs when clarity_verdict = needs_research.
 *
 * Calls the strong model to resolve jargon, brand names, and shorthand
 * into a canonical customs description. Returns an enriched description
 * that replaces cleaned_description for retrieval.
 *
 * Standard LLM (Sonnet-tier). Returns enriched_description even on failure
 * (falls back to original cleaned description).
 */
import { researchInput } from '../../../pipeline/track-a-description/researcher/research.js';

export interface ResearcherOutput {
  enriched_description: string;
  /** True when the researcher returned a canonical description. */
  recognised: boolean;
  /** Researcher reason string when not recognised. */
  unrecognised_reason: string | null;
  latency_ms: number;
}

export async function runResearcher(
  cleaned_description: string,
  raw_description: string,
): Promise<ResearcherOutput> {
  const result = await researchInput(cleaned_description || raw_description);

  if (result.kind === 'recognised') {
    return {
      enriched_description: result.canonical,
      recognised: true,
      unrecognised_reason: null,
      latency_ms: result.latencyMs,
    };
  }

  // 'unknown' or 'failed' — fall back to cleaned description so retrieval still runs.
  return {
    enriched_description: cleaned_description || raw_description,
    recognised: false,
    unrecognised_reason: result.kind === 'unknown' ? result.reason : result.error,
    latency_ms: result.latencyMs,
  };
}
