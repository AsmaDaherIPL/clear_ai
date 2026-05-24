/**
 * Pipeline rewrite — Stage 2a: identify_fast (PR 3).
 *
 * Sonnet WITHOUT the web_search tool. Single attempt, no parse-retry.
 * The model can:
 *   - Identify the product from world knowledge → return clean_product
 *   - Recognise the input as multiple distinct goods → return multi_product
 *   - Genuinely give up (placeholder, unknown brand, unknown SKU) →
 *     return uninformative with cause='genuine'
 *
 * When the fast pass returns uninformative+genuine or multi_product,
 * the orchestrator (PR 11) follows up with identify_web (PR 4) which
 * gets a web search.
 *
 * This module is code-blind to the merchant code by construction —
 * the function signature only takes the raw description. The prompt
 * never sees the merchant code.
 *
 * Outer-layer retries=0 to callLlmWithRetry (per existing pattern):
 * the inner callLlm 429-retry handles rate-limit recovery; we don't
 * compound tail latency on timeouts.
 */
import { z } from 'zod';
import { env } from '../../../../config/env.js';
import { callLlmWithRetry, type LlmCallResult } from '../../../../inference/llm/client.js';
import { getLlmStagePolicy } from '../../../../inference/llm/policy.js';
import { extractJson } from '../../../../inference/llm/parse-json.js';
import { loadPrompt } from '../../../../inference/llm/structured-call.js';
import {
  MAX_REASON_LENGTH,
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

/**
 * Permissive parse-target schema. Every field optional + unknown; the
 * coerce* helpers do real per-field validation. This matches the
 * legacy anchored identify's schema strategy.
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

function emptyTrace(): IdentifyCallTrace {
  return {
    pass: 'fast',
    llm_called: false,
    latency_ms: 0,
    model: null,
    status: 'skipped',
    web_search_used: false,
    evidence_mismatch: false,
  };
}

function traceFromCall(result: LlmCallResult): IdentifyCallTrace {
  // Fast pass NEVER uses web search (the tool isn't passed to the LLM).
  // If the model's self-reported `evidence` claims 'web', that's a
  // mismatch — surfaced for audit but the resolved evidence stays
  // 'world_knowledge'.
  return {
    pass: 'fast',
    llm_called: true,
    latency_ms: result.latencyMs,
    model: result.model,
    status: result.status,
    web_search_used: false,
    evidence_mismatch: false, // computed below when we have the parsed claim
  };
}

function uninformative(
  reason: string,
  cause: IdentifyCause,
  trace: IdentifyCallTrace,
): IdentifyResult {
  return {
    kind: 'uninformative',
    reason: reason.slice(0, MAX_REASON_LENGTH),
    cause,
    trace,
  };
}

/**
 * Build the IdentifyResult from a parsed LLM payload + the call result.
 * For the fast pass, `evidence` is always coerced to 'world_knowledge'
 * regardless of what the LLM self-reports (the tool wasn't available
 * to it). LLM self-reporting `evidence: 'web'` triggers evidence_mismatch.
 */
function buildResult(
  parsed: Record<string, unknown>,
  callResult: LlmCallResult,
): IdentifyResult {
  const kind = parsed.kind;
  const baseTrace = traceFromCall(callResult);

  if (kind === 'clean_product') {
    const canonicalRaw =
      typeof parsed.canonical === 'string' ? parsed.canonical.trim() : '';
    if (canonicalRaw.length === 0) {
      return uninformative(
        'LLM returned clean_product with empty canonical',
        'contract',
        baseTrace,
      );
    }
    const llmEvidence = parsed.evidence;
    const mismatch = llmEvidence === 'web'; // tool wasn't available, but LLM claimed web
    return {
      kind: 'clean_product',
      canonical: canonicalRaw,
      family_chapter: coerceFamilyChapter(parsed.family_chapter),
      identity_tokens: coerceIdentityTokens(parsed.identity_tokens),
      confidence: coerceConfidence(parsed.confidence),
      evidence: 'world_knowledge', // ground truth: tool not present in this pass
      trace: { ...baseTrace, evidence_mismatch: mismatch },
    };
  }

  if (kind === 'multi_product') {
    const products = coerceProducts(parsed.products);
    if (products.length < 2) {
      return uninformative(
        'LLM returned multi_product with fewer than 2 products',
        'contract',
        baseTrace,
      );
    }
    return { kind: 'multi_product', products, trace: baseTrace };
  }

  if (kind === 'uninformative') {
    const reason =
      typeof parsed.reason === 'string' ? parsed.reason : 'no reason given';
    // The fast-pass prompt instructs the model to use cause='genuine'
    // for all uninformative outcomes; the orchestrator routes based on
    // kind alone.
    return uninformative(reason, 'genuine', baseTrace);
  }

  return uninformative(
    `LLM returned unknown kind: ${String(kind)}`,
    'contract',
    baseTrace,
  );
}

function parseFastReply(result: LlmCallResult): IdentifyResult {
  if (result.status !== 'ok') {
    return uninformative(
      `LLM transport ${result.status}: ${result.error ?? 'no detail'}`,
      'transport',
      { ...traceFromCall(result), status: result.status },
    );
  }
  if (result.text === null || result.text.length === 0) {
    return uninformative(
      'LLM returned ok status but empty text',
      'transport',
      traceFromCall(result),
    );
  }
  const extracted = extractJson(result.text, IdentifyOutputSchema);
  if (!extracted.ok) {
    // Same PR-A-5.4 diagnostic — log a sample of the unparseable text
    // so we can debug from container logs without spelunking traces.
    const sample = (result.text ?? '').slice(0, 400).replace(/\s+/g, ' ');
    // eslint-disable-next-line no-console
    console.warn(
      `[identify_fast] parse-fail reason=${extracted.reason} text_length=${result.text.length} sample=${JSON.stringify(sample)}`,
    );
    return uninformative(
      `LLM output unparseable: ${extracted.reason}`,
      'parse',
      traceFromCall(result),
    );
  }
  return buildResult(extracted.data, result);
}

/**
 * Public entry. Stage 2a (fast pass).
 *
 * Never throws on LLM failures — those degrade to uninformative with
 * a populated `cause`. Throws only on programmer error (prompt file
 * missing).
 */
export async function runIdentifyFast(raw_description: string): Promise<IdentifyResult> {
  const trimmed = raw_description.trim();
  if (trimmed.length === 0) {
    return uninformative('empty input', 'short_circuit', emptyTrace());
  }
  const policy = getLlmStagePolicy('identify_fast');
  const system = await loadPrompt('identify-fast.md');

  const result = await callLlmWithRetry(
    {
      stage: 'identify_fast',
      system,
      user: trimmed,
      // Sonnet (LLM_MODEL_STRONG), not Haiku. A/B test on 2026-05-24
      // swapped this to LLM_MODEL (Haiku) and validated against
      // NQM26051745922 (29 rows): Haiku returns `family_chapter: null`
      // on most clean_product rows even when it correctly identifies
      // the canonical noun. That breaks the family_chapter retrieval
      // arm and pushes picker outputs into wrong chapters (gaming
      // controllers → 8471 instead of 9504). Web_fallback escalation
      // also ~doubled (10% → 28%) which erased the savings since
      // web_fallback is Sonnet+web_search.
      //
      // Net: Haiku saves ~$1.2k on the fast lane but spends $2-3k
      // extra on the web lane → net cost increase. Reverted.
      model: env().LLM_MODEL_STRONG,
      maxTokens: 400,
      temperature: 0,
      timeoutMs: policy.timeoutMs,
      // NO tools — this is the fast pass. Cost saving + latency saving
      // for the ~60% of rows the model resolves from training alone.
    },
    // 1 transport retry (so 2 total attempts). Inner 429 retry handles
    // rate limits transparently; this layer handles 5xx + timeout +
    // network. 2 × 15s worst case = 30s, well under what would force
    // identify_web_fallback to never run. Before this, a single 15s
    // timeout on identify_fast leaked an uninformative+transport into
    // the orchestrator, which then ran identify_web_fallback (another
    // 30s) and often still failed — burning 45s for a transient hiccup.
    1,
  );

  return parseFastReply(result);
}
