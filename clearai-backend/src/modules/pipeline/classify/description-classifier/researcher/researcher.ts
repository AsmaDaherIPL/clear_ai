/**
 * Track A / Researcher — runs when clarity_verdict = needs_research.
 *
 * Calls the strong model to resolve jargon, brand names, and shorthand
 * into a canonical customs description. Returns an enriched description
 * that replaces cleaned_description for retrieval.
 *
 * Two-tier escalation:
 *   1. researchInput   — cheap text-only LLM, world knowledge
 *   2. researchInputWithWeb — Anthropic-hosted web_search, used when (1)
 *      returns 'unknown' or when retrieval still failed after (1).
 *
 * Track A drives the escalation: it calls runResearcher() first, runs
 * retrieval + threshold; on failure it calls runWebResearcher() with the
 * raw input and re-runs retrieval. This lets the orchestrator decide
 * whether to spend the web budget instead of burning it on every call.
 */
import { researchInput } from './research.js';
import { researchInputWithWeb } from './research-with-web.js';

export interface ResearcherOutput {
  enriched_description: string;
  /** True when the researcher returned a canonical description. */
  recognised: boolean;
  /** Researcher reason string when not recognised. */
  unrecognised_reason: string | null;
  /** Source of the canonical (so the trace shows whether web was used). */
  source: 'cheap_llm' | 'web_search' | 'failed_passthrough';
  /** Optional evidence quote from the web researcher. */
  evidence_quote: string | null;
  latency_ms: number;
  model: string | null;
}

/** First-pass researcher (cheap, world knowledge only). */
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
      source: 'cheap_llm',
      evidence_quote: null,
      latency_ms: result.latencyMs,
      model: result.model,
    };
  }

  return {
    enriched_description: cleaned_description || raw_description,
    recognised: false,
    unrecognised_reason: result.kind === 'unknown' ? result.reason : result.error,
    source: 'failed_passthrough',
    evidence_quote: null,
    latency_ms: result.latencyMs,
    model: result.model,
  };
}

/**
 * Web-augmented researcher. Used by track-a as an escalation when
 * runResearcher() didn't yield enough signal for retrieval to find anything.
 */
export async function runWebResearcher(
  raw_description: string,
): Promise<ResearcherOutput> {
  const result = await researchInputWithWeb(raw_description, { maxSearches: 1 });

  if (result.kind === 'recognised') {
    return {
      enriched_description: result.canonical,
      recognised: true,
      unrecognised_reason: null,
      source: 'web_search',
      evidence_quote: result.evidenceQuote,
      latency_ms: result.latencyMs,
      model: result.model,
    };
  }

  return {
    enriched_description: raw_description,
    recognised: false,
    unrecognised_reason: result.kind === 'unknown' ? result.reason : result.error,
    source: 'failed_passthrough',
    evidence_quote: null,
    latency_ms: result.latencyMs,
    model: result.model,
  };
}
