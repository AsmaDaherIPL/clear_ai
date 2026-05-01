/**
 * LLM researcher (stage B). Resolves jargon / brand inputs that retrieval
 * scattered across tariff chapters. Returns RECOGNISED, UNKNOWN, or failed.
 */
import { callLlmWithRetry } from '../llm/client.js';
import { loadPrompt } from '../llm/structured-call.js';
import { env } from '../config/env.js';

export type ResearchOutcome =
  | { kind: 'recognised'; canonical: string; latencyMs: number; model: string }
  | { kind: 'unknown'; reason: string; latencyMs: number; model: string }
  | { kind: 'failed'; error: string; latencyMs: number; model: string };

/** Calls the strong model with the research prompt and parses its plain-text reply. */
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

  if (/^UNKNOWN\s*$/i.test(cleaned)) {
    return {
      kind: 'unknown',
      reason: 'unspecified',
      latencyMs: result.latencyMs,
      model: result.model,
    };
  }

  return {
    kind: 'failed',
    error: `researcher produced unparseable output: ${cleaned.slice(0, 120)}`,
    latencyMs: result.latencyMs,
    model: result.model,
  };
}
