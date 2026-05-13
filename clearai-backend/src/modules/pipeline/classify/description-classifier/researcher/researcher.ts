/**
 * Track A / Researcher — runs when clarity_verdict = needs_research.
 *
 * One module, two escalation tiers. Both tiers go through `callLlmWithRetry`
 * with explicit stage labels (`research_cheap`, `research_web`) so a single
 * LLM transport sees all researcher traffic — easier to wire a future
 * circuit-breaker / retry policy through one chokepoint.
 *
 * Two-tier escalation:
 *   1. runResearcher    — strong model, text-only world knowledge. Parses
 *                         the model's plain-text reply (`RECOGNISED: ...`
 *                         / `UNKNOWN: ...`). Cheap, no tools, 1 retry.
 *   2. runWebResearcher — strong model + Anthropic-hosted web_search.
 *                         JSON output via zod, 30s timeout, no retry
 *                         (web latency dominates; the breaker handles
 *                         repeated failure).
 *
 * Track A drives the escalation: it calls runResearcher() first, runs
 * retrieval + threshold; on failure it calls runWebResearcher() with the
 * raw input and re-runs retrieval. This lets the orchestrator decide
 * whether to spend the web budget instead of burning it on every call.
 */
import { z } from 'zod';
import { callLlmWithRetry, type LlmCallResult, type LlmTool } from '../../../../../inference/llm/client.js';
import { loadPrompt } from '../../../../../inference/llm/structured-call.js';
import { extractJson } from '../../../../../inference/llm/parse-json.js';
import { getLlmStagePolicy, type LlmStage } from '../../../../../inference/llm/policy.js';
import { env } from '../../../../../config/env.js';

/* ------------------------------------------------------------------ */
/*  Public types                                                       */
/* ------------------------------------------------------------------ */

/**
 * Internal outcome of a single research tier. The Track A orchestrator
 * never sees this — it consumes `ResearcherOutput`. Kept exported only
 * because `picker/interpretation.ts` imports the type alias for its own
 * downstream gating logic.
 */
export type ResearchOutcome =
  | { kind: 'recognised'; canonical: string; latencyMs: number; model: string }
  | { kind: 'unknown'; reason: string; latencyMs: number; model: string }
  | { kind: 'failed'; error: string; latencyMs: number; model: string };

export interface ResearcherOutput {
  enriched_description: string;
  recognised: boolean;
  unrecognised_reason: string | null;
  source: 'cheap_llm' | 'web_search' | 'failed_passthrough';
  evidence_quote: string | null;
  latency_ms: number;
  model: string | null;
  /** Total attempts including the first call (>=1). */
  attempts: number;
  /** Reason recorded for each attempt that triggered a parse retry. */
  retried_reasons: string[];
}

/* ------------------------------------------------------------------ */
/*  Shared transport                                                   */
/* ------------------------------------------------------------------ */

interface ResearchCallParams {
  stage: LlmStage;
  promptFile: string;
  user: string;
  model: string;
  maxTokens: number;
  retries: number;
  timeoutMs?: number;
  tools?: LlmTool[];
}

async function callResearchLlm(params: ResearchCallParams): Promise<LlmCallResult> {
  const system = await loadPrompt(params.promptFile);
  return callLlmWithRetry(
    {
      stage: params.stage,
      system,
      user: params.user.trim(),
      model: params.model,
      maxTokens: params.maxTokens,
      temperature: 0,
      ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
      ...(params.tools ? { tools: params.tools } : {}),
    },
    params.retries,
  );
}

/* ------------------------------------------------------------------ */
/*  Tier 1 — cheap text-only researcher                                */
/* ------------------------------------------------------------------ */

function parseCheapResearchReply(result: LlmCallResult): ResearchOutcome {
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

  const recognised = /^RECOGNISED\s*:\s*(.+)$/i.exec(cleaned);
  if (recognised?.[1]) {
    return { kind: 'recognised', canonical: recognised[1].trim(), latencyMs: result.latencyMs, model: result.model };
  }

  const unknown = /^UNKNOWN\s*:\s*(.+)$/i.exec(cleaned);
  if (unknown?.[1]) {
    return { kind: 'unknown', reason: unknown[1].trim(), latencyMs: result.latencyMs, model: result.model };
  }
  if (/^UNKNOWN\s*$/i.test(cleaned)) {
    return { kind: 'unknown', reason: 'unspecified', latencyMs: result.latencyMs, model: result.model };
  }

  return {
    kind: 'failed',
    error: `researcher produced unparseable output: ${cleaned.slice(0, 120)}`,
    latencyMs: result.latencyMs,
    model: result.model,
  };
}

/** First-pass researcher (cheap, world knowledge only). Never throws. */
export async function runResearcher(
  cleaned_description: string,
  raw_description: string,
): Promise<ResearcherOutput> {
  const input = cleaned_description || raw_description;
  const policy = getLlmStagePolicy('researcher_cheap');
  const model = env().LLM_MODEL_STRONG;
  const startedAt = Date.now();
  const retriedReasons: string[] = [];
  let attempts = 0;
  let totalLatencyMs = 0;
  let lastOutcome: ResearchOutcome | null = null;

  while (attempts < policy.maxAttempts) {
    if (attempts > 0 && Date.now() - startedAt >= policy.totalBudgetMs) break;
    attempts += 1;
    const result = await callResearchLlm({
      stage: 'researcher_cheap',
      promptFile: 'research-input.md',
      user: input,
      model,
      maxTokens: 100,
      // Transport-level retries are not the parse-retry loop; the stage
      // policy is now the single knob for retry behaviour.
      retries: 0,
      timeoutMs: policy.timeoutMs,
    });
    totalLatencyMs += result.latencyMs;
    const outcome = parseCheapResearchReply(result);
    lastOutcome = outcome;

    if (outcome.kind === 'recognised' || outcome.kind === 'unknown') break;

    // outcome.kind === 'failed' — treat regex non-match / transport failure
    // as a parse-class failure worth one retry under the policy.
    if (!policy.retryOnParseFailure || attempts >= policy.maxAttempts) break;
    retriedReasons.push('researcher_unparseable');
  }

  const outcome = lastOutcome!;
  if (outcome.kind === 'recognised') {
    return {
      enriched_description: outcome.canonical,
      recognised: true,
      unrecognised_reason: null,
      source: 'cheap_llm',
      evidence_quote: null,
      latency_ms: totalLatencyMs,
      model: outcome.model,
      attempts,
      retried_reasons: retriedReasons,
    };
  }

  return {
    enriched_description: input,
    recognised: false,
    unrecognised_reason: outcome.kind === 'unknown' ? outcome.reason : outcome.error,
    source: 'failed_passthrough',
    evidence_quote: null,
    latency_ms: totalLatencyMs,
    model: outcome.model,
    attempts,
    retried_reasons: retriedReasons,
  };
}

/* ------------------------------------------------------------------ */
/*  Tier 2 — web-augmented researcher                                  */
/* ------------------------------------------------------------------ */

const WebResearchSchema = z
  .object({
    kind: z.unknown().optional(),
    canonical: z.unknown().optional(),
    evidence_quote: z.unknown().optional(),
    reason: z.unknown().optional(),
  })
  .passthrough();

type WebResearchOutcome =
  | { kind: 'recognised'; canonical: string; evidenceQuote: string; latencyMs: number; model: string }
  | { kind: 'unknown'; reason: string; latencyMs: number; model: string }
  | { kind: 'failed'; error: string; latencyMs: number; model: string };

function parseWebResearchReply(result: LlmCallResult): WebResearchOutcome {
  if (result.status !== 'ok' || !result.text) {
    return {
      kind: 'failed',
      error: result.error ?? 'no text from web researcher',
      latencyMs: result.latencyMs,
      model: result.model,
    };
  }
  const extracted = extractJson(result.text, WebResearchSchema);
  if (!extracted.ok) {
    return {
      kind: 'failed',
      error: `${extracted.reason}: ${result.text.slice(0, 120)}`,
      latencyMs: result.latencyMs,
      model: result.model,
    };
  }
  const data = extracted.data;
  const kind = data.kind === 'recognised' ? 'recognised' : 'unknown';
  const canonical = typeof data.canonical === 'string' ? data.canonical.trim() : '';
  const evidenceQuote = typeof data.evidence_quote === 'string' ? data.evidence_quote.trim() : '';
  const reason = typeof data.reason === 'string' ? data.reason.trim() : 'unspecified';

  if (kind === 'recognised' && canonical && evidenceQuote) {
    return { kind: 'recognised', canonical, evidenceQuote, latencyMs: result.latencyMs, model: result.model };
  }
  return {
    kind: 'unknown',
    reason: reason || 'web research returned no usable identification',
    latencyMs: result.latencyMs,
    model: result.model,
  };
}

export interface WebResearcherOpts {
  enabled?: boolean;
  /** Hard ceiling on web searches per call. Default 1. */
  maxSearches?: number;
}

/**
 * Web-augmented researcher. Used by Track A as an escalation when
 * runResearcher() didn't yield enough signal for retrieval to find anything.
 * Never throws.
 */
export async function runWebResearcher(
  raw_description: string,
  opts: WebResearcherOpts = {},
): Promise<ResearcherOutput> {
  const { enabled = true, maxSearches = 1 } = opts;
  if (!enabled) {
    return {
      enriched_description: raw_description,
      recognised: false,
      unrecognised_reason: 'web research disabled',
      source: 'failed_passthrough',
      evidence_quote: null,
      latency_ms: 0,
      model: null,
      attempts: 0,
      retried_reasons: [],
    };
  }

  const policy = getLlmStagePolicy('researcher_web');
  const result = await callResearchLlm({
    stage: 'researcher_web',
    promptFile: 'research-with-web.md',
    user: raw_description,
    model: env().LLM_MODEL_STRONG,
    maxTokens: 400,
    retries: 0,
    timeoutMs: policy.timeoutMs,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxSearches }],
  });
  const outcome = parseWebResearchReply(result);
  // researcher_web policy is maxAttempts=1 today; single shot, no parse retry.
  const attempts = 1;

  if (outcome.kind === 'recognised') {
    return {
      enriched_description: outcome.canonical,
      recognised: true,
      unrecognised_reason: null,
      source: 'web_search',
      evidence_quote: outcome.evidenceQuote,
      latency_ms: outcome.latencyMs,
      model: outcome.model,
      attempts,
      retried_reasons: [],
    };
  }

  return {
    enriched_description: raw_description,
    recognised: false,
    unrecognised_reason: outcome.kind === 'unknown' ? outcome.reason : outcome.error,
    source: 'failed_passthrough',
    evidence_quote: null,
    latency_ms: outcome.latencyMs,
    model: outcome.model,
    attempts,
    retried_reasons: [],
  };
}
