/**
 * Identify stage (anchored pipeline, stage 1 of 3).
 *
 * Single Sonnet call with Foundry-hosted web_search tool. Replaces the
 * legacy cleanup + cheap-researcher + web-researcher chain with one
 * web-first stage that produces a typed IdentifyResult + trace.
 *
 * Contract:
 *   - Blinded to the merchant code (per the rationale's
 *     anchoring-avoidance principle). The caller is responsible for
 *     not leaking the code into raw_description.
 *   - Empty / whitespace-only input short-circuits to uninformative
 *     (cause='short_circuit') without an LLM call.
 *   - Any LLM transport failure (error, timeout, empty text) degrades
 *     to uninformative (cause='transport') rather than throwing.
 *   - Out-of-contract LLM output (bad JSON, unknown kind, empty
 *     canonical on clean_product, multi_product with <2 products)
 *     degrades to uninformative (cause='parse' or 'contract').
 *   - The orchestrator decides what to do with uninformative rows
 *     based on `cause` and whether a merchant code is available.
 *
 * Every code path produces a trace row (latency, model, status,
 * web_search_used, evidence_mismatch) so PR-A-5 can persist a uniform
 * audit trail.
 *
 * Production model: env.LLM_MODEL_STRONG (Sonnet by default).
 * Production stage policy: see policy.ts `identify` entry.
 */
import { z } from 'zod';
import { callLlmWithRetry, type LlmCallResult } from '../../../inference/llm/client.js';
import { loadPrompt } from '../../../inference/llm/structured-call.js';
import { extractJson } from '../../../inference/llm/parse-json.js';
import { getLlmStagePolicy } from '../../../inference/llm/policy.js';
import { env } from '../../../config/env.js';
import type { IdentifyResult, IdentifyCallTrace } from './identify.types.js';

/**
 * Zod schema for the LLM's JSON output. Every field is z.unknown() at
 * the schema level because the LLM is genuinely untrusted output;
 * field-by-field coercion happens after extraction.
 */
const IdentifyOutputSchema = z
  .object({
    kind: z.unknown().optional(),
    canonical: z.unknown().optional(),
    family_chapter: z.unknown().optional(),
    identity_tokens: z.unknown().optional(),
    confidence: z.unknown().optional(),
    evidence: z.unknown().optional(),
    products: z.unknown().optional(),
    reason: z.unknown().optional(),
  })
  .passthrough();

const MAX_IDENTITY_TOKENS = 4;
const MAX_IDENTITY_TOKEN_LENGTH = 40;
const MAX_PRODUCTS = 8;
const MAX_PRODUCT_LABEL_LENGTH = 200;
const MAX_REASON_LENGTH = 200;

/** Build a fresh trace shape; default for short-circuit paths. */
function emptyTrace(): IdentifyCallTrace {
  return {
    llm_called: false,
    latency_ms: 0,
    model: null,
    status: 'skipped',
    web_search_used: false,
    evidence_mismatch: false,
  };
}

/** Build a trace shape from a completed LLM call. web_search_used is
 *  authoritative (counted from the response's tool_use blocks). */
function traceFromCall(result: LlmCallResult, evidenceMismatch: boolean): IdentifyCallTrace {
  return {
    llm_called: true,
    latency_ms: result.latencyMs,
    model: result.model,
    status: result.status,
    web_search_used: countToolUseBlocks(result.raw) > 0,
    evidence_mismatch: evidenceMismatch,
  };
}

/**
 * Count `tool_use` blocks in the Anthropic response. The web tool
 * appears as a block with `type === 'tool_use'`. Source of truth for
 * "was the web search actually called" — cross-checks the LLM's
 * self-reported `evidence` field.
 */
function countToolUseBlocks(raw: unknown): number {
  if (raw === null || typeof raw !== 'object') return 0;
  const content = (raw as { content?: unknown }).content;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const block of content) {
    if (block !== null && typeof block === 'object') {
      const blockType = (block as { type?: unknown }).type;
      if (blockType === 'tool_use') n++;
    }
  }
  return n;
}

/** Construct an uninformative result with the given cause + trace. */
function uninformative(
  reason: string,
  cause: 'genuine' | 'short_circuit' | 'transport' | 'parse' | 'contract',
  trace: IdentifyCallTrace,
): IdentifyResult {
  return {
    kind: 'uninformative',
    reason: reason.slice(0, MAX_REASON_LENGTH),
    cause,
    trace,
  };
}

/** Coerce LLM family_chapter into a valid 2-digit string or null. */
function coerceFamilyChapter(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (!/^(?:0[1-9]|[1-9][0-9])$/.test(trimmed)) return null;
  return trimmed;
}

/** Clamp confidence into [0, 1]; reject non-numbers as 0. */
function coerceConfidence(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/** Coerce identity_tokens: array of non-empty strings, capped at length. */
function coerceIdentityTokens(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const entry of v) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_IDENTITY_TOKEN_LENGTH) continue;
    out.push(trimmed);
    if (out.length >= MAX_IDENTITY_TOKENS) break;
  }
  return out;
}

/** Coerce multi_product products: array of non-empty strings, capped. */
function coerceProducts(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const entry of v) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_PRODUCT_LABEL_LENGTH) continue;
    out.push(trimmed);
    if (out.length >= MAX_PRODUCTS) break;
  }
  return out;
}

/**
 * Resolve the authoritative `evidence` value from the LLM's self-report
 * cross-checked against the transport-level tool-use signal.
 * Returns the resolved evidence + a mismatch flag.
 */
function resolveEvidence(
  selfReported: unknown,
  webSearchUsed: boolean,
): { evidence: 'web' | 'world_knowledge'; mismatch: boolean } {
  // Transport is the ground truth: if web_search actually ran, evidence
  // is 'web'; otherwise it's 'world_knowledge'. The LLM's self-report
  // is only used to detect disagreements (which the trace surfaces).
  const transportEvidence: 'web' | 'world_knowledge' = webSearchUsed ? 'web' : 'world_knowledge';
  const llmReported = selfReported === 'web' ? 'web' : selfReported === 'world_knowledge' ? 'world_knowledge' : null;
  const mismatch = llmReported !== null && llmReported !== transportEvidence;
  return { evidence: transportEvidence, mismatch };
}

/**
 * Build the IdentifyResult from a parsed LLM payload + the call result
 * (for trace + transport-level evidence cross-check).
 */
function buildResult(
  parsed: Record<string, unknown>,
  callResult: LlmCallResult,
): IdentifyResult {
  const kind = parsed.kind;
  const webSearchUsed = countToolUseBlocks(callResult.raw) > 0;

  if (kind === 'clean_product') {
    const canonicalRaw = typeof parsed.canonical === 'string' ? parsed.canonical.trim() : '';
    if (canonicalRaw.length === 0) {
      return uninformative(
        'LLM returned clean_product with empty canonical',
        'contract',
        traceFromCall(callResult, false),
      );
    }
    const { evidence, mismatch } = resolveEvidence(parsed.evidence, webSearchUsed);
    return {
      kind: 'clean_product',
      canonical: canonicalRaw,
      family_chapter: coerceFamilyChapter(parsed.family_chapter),
      identity_tokens: coerceIdentityTokens(parsed.identity_tokens),
      confidence: coerceConfidence(parsed.confidence),
      evidence,
      trace: traceFromCall(callResult, mismatch),
    };
  }

  if (kind === 'multi_product') {
    const products = coerceProducts(parsed.products);
    if (products.length < 2) {
      return uninformative(
        'LLM returned multi_product with fewer than 2 products',
        'contract',
        traceFromCall(callResult, false),
      );
    }
    return {
      kind: 'multi_product',
      products,
      trace: traceFromCall(callResult, false),
    };
  }

  if (kind === 'uninformative') {
    const reasonRaw = typeof parsed.reason === 'string' ? parsed.reason.trim() : '';
    return uninformative(
      reasonRaw || 'unspecified',
      'genuine',
      traceFromCall(callResult, false),
    );
  }

  return uninformative(
    `LLM returned unknown kind: ${String(kind)}`,
    'contract',
    traceFromCall(callResult, false),
  );
}

/** Parse the LLM call's result into an IdentifyResult. */
function parseIdentifyReply(result: LlmCallResult): IdentifyResult {
  if (result.status !== 'ok') {
    return uninformative(
      `LLM transport ${result.status}: ${result.error ?? 'no detail'}`,
      'transport',
      traceFromCall(result, false),
    );
  }
  if (result.text === null || result.text.length === 0) {
    return uninformative(
      'LLM returned ok status but empty text',
      'transport',
      traceFromCall(result, false),
    );
  }
  const extracted = extractJson(result.text, IdentifyOutputSchema);
  if (!extracted.ok) {
    return uninformative(
      `LLM output unparseable: ${extracted.reason}`,
      'parse',
      traceFromCall(result, false),
    );
  }
  return buildResult(extracted.data, result);
}

/**
 * Public entry. Stage 1 of the anchored pipeline.
 *
 * Returns IdentifyResult (typed union, always carries a trace).
 * Never throws on LLM failures — those degrade to uninformative with
 * a populated `cause` field. Throws only on programmer error
 * (e.g. prompt file missing).
 */
export async function runIdentify(raw_description: string): Promise<IdentifyResult> {
  // Short-circuit on empty / whitespace-only input. Belt-and-suspenders
  // — the upstream parse stage already rejects empties — but keeps
  // runIdentify safe to call directly from tests and ad-hoc tools.
  const trimmed = raw_description.trim();
  if (trimmed.length === 0) {
    return uninformative('empty input', 'short_circuit', emptyTrace());
  }

  const policy = getLlmStagePolicy('identify');
  const system = await loadPrompt('identify.md');

  const result = await callLlmWithRetry(
    {
      stage: 'identify',
      system,
      user: trimmed,
      model: env().LLM_MODEL_STRONG,
      maxTokens: 600,
      temperature: 0,
      timeoutMs: policy.timeoutMs,
      // One web search per identification. The model decides whether
      // to call it based on the prompt's tool-use rules.
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
    },
    // No transport-level retries — web latency dominates a single
    // call; retrying compounds tail latency. Circuit breaker handles
    // sustained failures. Matches researcher_web policy.
    0,
  );

  return parseIdentifyReply(result);
}
