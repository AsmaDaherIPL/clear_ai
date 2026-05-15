/**
 * Pipeline rewrite — Stage 2b: identify_web fallback (PR 4).
 *
 * Sonnet WITH web_search tool. Fires only when identify_fast (PR 3)
 * returned uninformative+genuine OR multi_product. Receives the fast
 * pass's previous result as context so the model knows what was tried.
 *
 * Same shape contract as identify_fast — returns IdentifyResult. The
 * orchestrator replaces the fast result with the web result entirely;
 * they're not merged.
 *
 * Outer-layer retries=0 (same rationale as identify_fast); web tool
 * latency dominates and inner 429 retry handles rate limits.
 */
import { z } from 'zod';
import { env } from '../../../../config/env.js';
import { callLlmWithRetry, type LlmCallResult } from '../../../../inference/llm/client.js';
import { getLlmStagePolicy } from '../../../../inference/llm/policy.js';
import { extractJson } from '../../../../inference/llm/parse-json.js';
import { loadPrompt } from '../../../../inference/llm/structured-call.js';
import {
  MAX_REASON_LENGTH,
  coerceBrandAlternatives,
  coerceConfidence,
  coerceFamilyChapter,
  coerceIdentityTokens,
  coerceProducts,
} from './coerce.js';
import type {
  IdentifyCallTrace,
  IdentifyCause,
  IdentifyResult,
} from '../types.js';

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
    /**
     * Brand-only rescue: other product lines of the brand the model
     * could have committed to. Surfaced to the SPA / HITL reviewer
     * for context; not used downstream by retrieval.
     */
    brand_alternatives: z.unknown().optional(),
  })
  .passthrough();

function countToolUseBlocks(raw: unknown): number {
  if (raw === null || typeof raw !== 'object') return 0;
  const content = (raw as { content?: unknown }).content;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const block of content) {
    if (block !== null && typeof block === 'object') {
      const t = (block as { type?: unknown }).type;
      // Foundry / Anthropic emits 'server_tool_use' for hosted web_search
      // and 'tool_use' for client-side tools. Count both as evidence that
      // the search ran.
      if (t === 'tool_use' || t === 'server_tool_use') n++;
    }
  }
  return n;
}

function traceFromCall(result: LlmCallResult, evidenceMismatch: boolean): IdentifyCallTrace {
  return {
    pass: 'web',
    llm_called: true,
    latency_ms: result.latencyMs,
    model: result.model,
    status: result.status,
    web_search_used: countToolUseBlocks(result.raw) > 0,
    evidence_mismatch: evidenceMismatch,
  };
}

function uninformative(
  reason: string,
  cause: IdentifyCause,
  trace: IdentifyCallTrace,
): IdentifyResult {
  return { kind: 'uninformative', reason: reason.slice(0, MAX_REASON_LENGTH), cause, trace };
}

function resolveEvidence(
  selfReported: unknown,
  webSearchUsed: boolean,
): { evidence: 'web' | 'world_knowledge'; mismatch: boolean } {
  const transportEvidence: 'web' | 'world_knowledge' = webSearchUsed ? 'web' : 'world_knowledge';
  const llmReported =
    selfReported === 'web' ? 'web' : selfReported === 'world_knowledge' ? 'world_knowledge' : null;
  const mismatch = llmReported !== null && llmReported !== transportEvidence;
  return { evidence: transportEvidence, mismatch };
}

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
    // Brand-only rescue: model commits to a flagship product line at
    // low confidence and lists other lines as alternatives. The
    // alternatives field is optional; absent on description-based
    // identifies.
    const brandAlternatives = coerceBrandAlternatives(parsed.brand_alternatives);
    return {
      kind: 'clean_product',
      canonical: canonicalRaw,
      family_chapter: coerceFamilyChapter(parsed.family_chapter),
      identity_tokens: coerceIdentityTokens(parsed.identity_tokens),
      confidence: coerceConfidence(parsed.confidence),
      evidence,
      ...(brandAlternatives.length > 0 ? { brand_alternatives: brandAlternatives } : {}),
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
    return { kind: 'multi_product', products, trace: traceFromCall(callResult, false) };
  }

  if (kind === 'uninformative') {
    const reason = typeof parsed.reason === 'string' ? parsed.reason : 'no reason given';
    return uninformative(reason, 'genuine', traceFromCall(callResult, false));
  }

  return uninformative(
    `LLM returned unknown kind: ${String(kind)}`,
    'contract',
    traceFromCall(callResult, false),
  );
}

function parseWebReply(result: LlmCallResult): IdentifyResult {
  if (result.status !== 'ok') {
    return uninformative(
      `LLM transport ${result.status}: ${result.error ?? 'no detail'}`,
      'transport',
      {
        pass: 'web',
        llm_called: true,
        latency_ms: result.latencyMs,
        model: result.model,
        status: result.status,
        web_search_used: false,
        evidence_mismatch: false,
      },
    );
  }
  if (result.text === null || result.text.length === 0) {
    return uninformative('LLM returned ok status but empty text', 'transport', {
      pass: 'web',
      llm_called: true,
      latency_ms: result.latencyMs,
      model: result.model,
      status: 'error',
      web_search_used: false,
      evidence_mismatch: false,
    });
  }
  const extracted = extractJson(result.text, IdentifyOutputSchema);
  if (!extracted.ok) {
    const sample = (result.text ?? '').slice(0, 400).replace(/\s+/g, ' ');
    // eslint-disable-next-line no-console
    console.warn(
      `[identify_web] parse-fail reason=${extracted.reason} text_length=${result.text.length} sample=${JSON.stringify(sample)}`,
    );
    return uninformative(
      `LLM output unparseable: ${extracted.reason}`,
      'parse',
      traceFromCall(result, false),
    );
  }
  return buildResult(extracted.data, result);
}

/**
 * Web fallback identify. Takes the raw description + the fast pass's
 * IdentifyResult as context so the prompt can see what was tried.
 * Returns the IdentifyResult that REPLACES the fast pass result for
 * downstream stages.
 *
 * `value_hint` carries the declared line value (in the merchant's
 * currency) plus the currency code, so the brand-only handler in the
 * prompt can use price-band signal to disambiguate which product line
 * of a multi-category brand the row most likely represents. Example:
 * "maxhub" at 150 SAR → accessory (cable / pen), not a 30,000-SAR
 * interactive flat-panel display. Pass null when no value is available
 * (rare — the pipeline always parses one).
 */
export async function runIdentifyWeb(
  raw_description: string,
  previousAttempt: IdentifyResult,
  value_hint?: { amount: number; currency: string } | null,
): Promise<IdentifyResult> {
  // Normalise the optional value hint so the user payload always
  // carries the field (null when absent). Tests and older callers
  // omitting the param degrade gracefully — no price-tier signal but
  // the brand-only handler can still pick the flagship line.
  const valueHint = value_hint ?? null;
  const trimmed = raw_description.trim();
  if (trimmed.length === 0) {
    return uninformative('empty input', 'short_circuit', {
      pass: 'web',
      llm_called: false,
      latency_ms: 0,
      model: null,
      status: 'skipped',
      web_search_used: false,
      evidence_mismatch: false,
    });
  }

  const policy = getLlmStagePolicy('identify_web_fallback');
  const system = await loadPrompt('identify-web.md');

  // Build user payload: raw description + previous_attempt context +
  // value_hint so the brand-only path can use price tier to choose
  // which product line of a multi-category brand to commit to.
  const userPayload = JSON.stringify({
    description: trimmed,
    previous_attempt: summarisePrevious(previousAttempt),
    value_hint: valueHint,
  });

  const result = await callLlmWithRetry(
    {
      stage: 'identify_web_fallback',
      system,
      user: userPayload,
      model: env().LLM_MODEL_STRONG,
      maxTokens: 1500,
      temperature: 0,
      timeoutMs: policy.timeoutMs,
      // One web search per fallback call. The model decides whether to
      // actually use it based on the prompt's tool-use rules.
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
    },
    // Same outer-retries=0 pattern as identify_fast.
    0,
  );

  return parseWebReply(result);
}

/**
 * Trim the previous IdentifyResult into a compact summary the prompt
 * can read. We don't pass the full trace — only the kind, cause, and
 * reason that explain why the fast pass gave up.
 */
function summarisePrevious(prev: IdentifyResult): Record<string, unknown> {
  if (prev.kind === 'clean_product') {
    // Unusual to web-fallback after clean_product (orchestrator
    // shouldn't), but support it: the fast pass found something but the
    // caller decided to double-check.
    return {
      kind: 'clean_product',
      canonical: prev.canonical,
      family_chapter: prev.family_chapter,
      confidence: prev.confidence,
    };
  }
  if (prev.kind === 'multi_product') {
    return { kind: 'multi_product', products: prev.products };
  }
  return { kind: 'uninformative', cause: prev.cause, reason: prev.reason };
}
