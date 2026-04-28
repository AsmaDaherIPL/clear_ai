/**
 * Web-search-augmented researcher (Phase F).
 *
 * Fires only after the standard `research.ts` returns UNKNOWN. The standard
 * researcher has access to Sonnet's pre-training memory only; for genuinely
 * unrecognisable brand+SKU shorthand (Birkenstock Arizona BFBC Mocca43,
 * Loewe Puzzle bag, etc.) pre-training memory has uneven coverage of the
 * fashion / electronics long tail. One web search per request is enough
 * to resolve most of those cases — the search snippet contains the product
 * class in plain text and Sonnet just needs to read it.
 *
 * Verified empirically that Foundry's passthrough exposes Anthropic's
 * hosted Web Search tool (`web_search_20250305`) on Sonnet 4.6+. The tool
 * is server-side: Anthropic runs the search and streams `web_search_tool_result`
 * blocks before the final assistant text. We don't orchestrate the tool;
 * we just enable it via the `tools` parameter and read the model's final
 * synthesis.
 *
 * Safety mechanisms:
 *   1. Hard cap of 1 search per request (max_uses=1) — bounded cost.
 *   2. `evidence_quote` field on the response: the model must cite a
 *      specific phrase from the snippets. We don't validate the quote
 *      against the snippet content (that would require parsing the
 *      tool blocks structurally — possible but adds complexity), but
 *      the prompt rule pushes the model away from inventing.
 *   3. Anti-fragment-association rules in the prompt mirror the standard
 *      researcher's rules — we don't want web evidence opening a new
 *      hallucination surface.
 *   4. Feature-flagged via setup_meta.RESEARCH_WEB_ENABLED. Default 0
 *      so the first deploy ships disabled; flip to 1 once we've measured
 *      cost/quality on real traffic. Each call is a Sonnet round-trip
 *      with tool-use, ~3-5s additional latency on the UNKNOWN branch.
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
  /** Default true; set to false to skip without going through setup_meta. */
  enabled?: boolean;
  /** Cap on tokens the model may emit. Default 400 (small JSON payload). */
  maxTokens?: number;
  /** Override the model. Defaults to env LLM_MODEL_STRONG. */
  model?: string;
  /**
   * Cap on web searches per call. The hosted tool tracks this server-side;
   * we send it on the request as a hard ceiling. Default 1 — enough to
   * answer most product-identification questions, prevents runaway costs.
   */
  maxSearches?: number;
}

/**
 * Run the web-augmented researcher on a raw input. Always returns a result
 * (never throws) — failures degrade to `kind: 'failed'` so the caller can
 * fall back to whatever it would have done without web evidence.
 */
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
    // No retries — web search is expensive and a transient failure should
    // route to the deterministic abstention path, not burn budget.
    retries: 0,
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
