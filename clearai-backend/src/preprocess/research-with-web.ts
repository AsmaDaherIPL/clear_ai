/**
 * Web-search-augmented researcher. Fires when research.ts returns UNKNOWN.
 * Uses Anthropic's hosted web_search tool with a hard cap on uses.
 */
import { z } from 'zod';
import { structuredLlmCall } from '../llm/structured-call.js';
import { env } from '../config/env.js';

export type ResearchWithWebKind = 'recognised' | 'unknown';

export type ResearchWithWebOutcome =
  | {
      kind: 'recognised';
      canonical: string;
      evidenceQuote: string;
      latencyMs: number;
      model: string;
    }
  | {
      kind: 'unknown';
      reason: string;
      latencyMs: number;
      model: string;
    }
  | {
      kind: 'failed';
      error: string;
      latencyMs: number;
      model: string;
    };

const ResearchWithWebSchema = z
  .object({
    kind: z.unknown().optional(),
    canonical: z.unknown().optional(),
    evidence_quote: z.unknown().optional(),
    reason: z.unknown().optional(),
  })
  .passthrough();

export interface ResearchWithWebOpts {
  enabled?: boolean;
  /** Default 400. */
  maxTokens?: number;
  /** Defaults to env LLM_MODEL_STRONG. */
  model?: string;
  /** Hard ceiling on web searches per call. Default 1. */
  maxSearches?: number;
}

/** Run the web-augmented researcher. Never throws; failures → kind='failed'. */
export async function researchInputWithWeb(
  rawInput: string,
  opts: ResearchWithWebOpts = {},
): Promise<ResearchWithWebOutcome> {
  const { enabled = true, maxTokens = 400, maxSearches = 1 } = opts;

  if (!enabled) {
    return { kind: 'failed', error: 'web research disabled', latencyMs: 0, model: '' };
  }

  const e = env();
  const model = opts.model ?? e.LLM_MODEL_STRONG;

  const outcome = await structuredLlmCall({
    promptFile: 'research-with-web.md',
    user: rawInput.trim(),
    schema: ResearchWithWebSchema,
    stage: 'research_web',
    model,
    maxTokens,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxSearches }],
    retries: 0,
    timeoutMs: 30_000,
  });

  if (outcome.kind !== 'ok') {
    const errMessage =
      outcome.kind === 'llm_failed'
        ? outcome.error
        : `unparseable JSON: ${'rawText' in outcome ? outcome.rawText.slice(0, 120) : ''}`;
    return {
      kind: 'failed',
      error: errMessage,
      latencyMs: outcome.trace.latency_ms,
      model: outcome.trace.model,
    };
  }

  const parsed = outcome.data;
  const kind = parsed.kind === 'recognised' ? 'recognised' : 'unknown';
  const canonical =
    typeof parsed.canonical === 'string' ? parsed.canonical.trim() : '';
  const evidenceQuote =
    typeof parsed.evidence_quote === 'string' ? parsed.evidence_quote.trim() : '';
  const reason =
    typeof parsed.reason === 'string' ? parsed.reason.trim() : 'unspecified';

  if (kind === 'recognised' && canonical && evidenceQuote) {
    return {
      kind: 'recognised',
      canonical,
      evidenceQuote,
      latencyMs: outcome.trace.latency_ms,
      model: outcome.trace.model,
    };
  }

  return {
    kind: 'unknown',
    reason: reason || 'web research returned no usable identification',
    latencyMs: outcome.trace.latency_ms,
    model: outcome.trace.model,
  };
}
