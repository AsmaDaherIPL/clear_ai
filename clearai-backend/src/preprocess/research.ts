/**
 * LLM researcher (stage B). Runs only when `checkUnderstanding` says retrieval
 * couldn't make sense of the input — typically jargon-heavy or
 * proper-noun-laden inputs that retrieval scattered across many tariff
 * chapters.
 *
 * Uses the strong model (LLM_MODEL_STRONG) rather than the weak model because
 * world-knowledge of brands and product lines is the differentiator here.
 * The weak model is more prone to confidently mis-identifying the product
 * class; the strong model is more likely to either recognise the input
 * correctly or honestly return UNKNOWN.
 *
 * Output is one of two structured forms — see prompts/research-input.md.
 * Returning UNKNOWN is a feature, not a failure: it surfaces honest uncertainty
 * to the user instead of a confident-wrong code with legal consequences.
 */
import { callLlmWithRetry } from '../llm/client.js';
import { loadPrompt } from '../llm/structured-call.js';
import { env } from '../config/env.js';

// Researcher returns plain-text (RECOGNISED: ... / UNKNOWN: ...), not JSON,
// so we use `loadPrompt` for the shared prompt cache but call the LLM
// client directly rather than going through `structuredLlmCall`.
// Phase F (web-search-augmented researcher) will adopt a JSON shape and
// move to `structuredLlmCall` proper.

export type ResearchOutcome =
  | { kind: 'recognised'; canonical: string; latencyMs: number; model: string }
  | { kind: 'unknown'; reason: string; latencyMs: number; model: string }
  | { kind: 'failed'; error: string; latencyMs: number; model: string };

/**
 * Calls Sonnet with the research prompt. The prompt is engineered to return
 * exactly one of two single-line forms; we parse defensively in case the
 * model adds wrapping whitespace or quotes.
 */
export async function researchInput(rawInput: string): Promise<ResearchOutcome> {
  const system = await loadPrompt('research-input.md');
  const result = await callLlmWithRetry(
    {
      model: env().LLM_MODEL_STRONG,
      system,
      user: rawInput.trim(),
      maxTokens: 100,
      temperature: 0,
    },
    1,
  );

  if (result.status !== 'ok' || !result.text) {
    return {
      kind: 'failed',
      error: result.error ?? 'no text from researcher',
      latencyMs: result.latencyMs,
      model: result.model,
    };
  }

  // Take only the first non-empty line and strip wrapping quotes/whitespace.
  const firstLine =
    result.text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? '';
  const cleaned = firstLine.replace(/^["'`]+|["'`]+$/g, '').trim();

  const recognisedMatch = /^RECOGNISED\s*:\s*(.+)$/i.exec(cleaned);
  if (recognisedMatch && recognisedMatch[1]) {
    return {
      kind: 'recognised',
      canonical: recognisedMatch[1].trim(),
      latencyMs: result.latencyMs,
      model: result.model,
    };
  }

  const unknownMatch = /^UNKNOWN\s*:\s*(.+)$/i.exec(cleaned);
  if (unknownMatch && unknownMatch[1]) {
    return {
      kind: 'unknown',
      reason: unknownMatch[1].trim(),
      latencyMs: result.latencyMs,
      model: result.model,
    };
  }

  // Bare "UNKNOWN" with no reason — treat as unknown rather than failing.
  if (/^UNKNOWN\s*$/i.test(cleaned)) {
    return {
      kind: 'unknown',
      reason: 'unspecified',
      latencyMs: result.latencyMs,
      model: result.model,
    };
  }

  // Anything else is a prompt-compliance failure. Treat as failed so the
  // route can fall back to the original (unmodified) retrieval result.
  return {
    kind: 'failed',
    error: `researcher produced unparseable output: ${cleaned.slice(0, 120)}`,
    latencyMs: result.latencyMs,
    model: result.model,
  };
}
