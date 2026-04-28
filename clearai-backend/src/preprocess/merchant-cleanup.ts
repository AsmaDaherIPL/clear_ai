/**
 * Phase 1.5 — Merchant-input cleanup. Proactive Haiku-based stripping of
 * brand / SKU / marketing noise BEFORE retrieval. Two layers:
 *   1. Deterministic short-circuit (`looksClean`) — ≤80% of inputs pass
 *      through unchanged.
 *   2. Haiku call returns {kind: product|merchant_shorthand|ungrounded,
 *      clean_description, attributes, stripped}.
 * Haiku not Sonnet: this is extraction, not legal reasoning.
 */
import { z } from 'zod';
import { structuredLlmCall } from '../llm/structured-call.js';
import { env } from '../config/env.js';

export type MerchantCleanupKind = 'product' | 'merchant_shorthand' | 'ungrounded';

export interface MerchantCleanupResult {
  invoked: 'skipped_clean' | 'llm' | 'llm_failed' | 'llm_unparseable';
  /** Only meaningful when invoked='llm'. */
  kind: MerchantCleanupKind;
  /** Falls back to raw input on skip/failure — pipeline never blocks on cleanup. */
  effective: string;
  attributes: string[];
  stripped: string[];
  latencyMs: number;
  model?: string | undefined;
}

/**
 * Skip cleanup when the input is already broker-grade: ≤4 tokens, no ASIN,
 * no marketing punctuation, no model codes (4+ char alphanumeric mixes
 * like "WH-1000XM5", "Mocca43").
 */
export function looksClean(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return true;
  if (trimmed.length > 80) return false;

  const tokens = trimmed.split(/\s+/);
  if (tokens.length > 4) return false;
  if (/B0[A-Z0-9]{8}/.test(trimmed)) return false;
  if (/[,(){}[\]/]/.test(trimmed)) return false;

  // Reject tokens that look like model codes (4+ alphanumerics with digit+letter mix).
  for (const tok of tokens) {
    const cleaned = tok.replace(/[^A-Za-z0-9]/g, '');
    if (cleaned.length < 4) continue;
    if (/\d/.test(cleaned) && /[A-Za-z]/.test(cleaned)) return false;
  }
  return true;
}

// Loose schema — fields validated by post-extraction code, not Zod.
const ParsedCleanupSchema = z
  .object({
    kind: z.unknown().optional(),
    clean_description: z.unknown().optional(),
    attributes: z.unknown().optional(),
    stripped: z.unknown().optional(),
  })
  .passthrough();

const KIND_VALUES = new Set<MerchantCleanupKind>(['product', 'merchant_shorthand', 'ungrounded']);

function coerceStringArray(v: unknown, max = 16): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 200)
    .slice(0, max);
}

export interface CleanupOpts {
  /** Cap on LLM output tokens. Default 200 (the JSON is small). */
  maxTokens?: number;
  /** Override the model (defaults to env LLM_MODEL — the weak/Haiku model). */
  model?: string;
}

/**
 * Run cleanup on a raw merchant description.
 *
 * Always returns a result — never throws on LLM failure. The caller decides
 * whether to act on `kind` or just use `effective` as the retrieval input.
 */
export async function cleanMerchantInput(
  rawInput: string,
  opts: CleanupOpts = {},
): Promise<MerchantCleanupResult> {
  const trimmed = rawInput.trim();

  if (looksClean(trimmed)) {
    return {
      invoked: 'skipped_clean',
      kind: 'product',
      effective: trimmed,
      attributes: [],
      stripped: [],
      latencyMs: 0,
    };
  }

  const e = env();
  const model = opts.model ?? e.LLM_MODEL;
  const maxTokens = opts.maxTokens ?? 200;

  const outcome = await structuredLlmCall({
    promptFile: 'merchant-cleanup.md',
    user: `Input: ${trimmed}\n\nReturn the JSON object only.`,
    schema: ParsedCleanupSchema,
    stage: 'cleanup',
    model,
    maxTokens,
  });

  // On any non-ok outcome, fall back to the raw input. Pipeline never blocks on cleanup.
  if (outcome.kind === 'llm_failed') {
    return {
      invoked: 'llm_failed',
      kind: 'product',
      effective: trimmed,
      attributes: [],
      stripped: [],
      latencyMs: outcome.trace.latency_ms,
      model,
    };
  }
  if (outcome.kind !== 'ok') {
    return {
      invoked: 'llm_unparseable',
      kind: 'product',
      effective: trimmed,
      attributes: [],
      stripped: [],
      latencyMs: outcome.trace.latency_ms,
      model,
    };
  }
  const parsed = outcome.data;
  const llmTrace = outcome.trace;

  const kind: MerchantCleanupKind = KIND_VALUES.has(parsed.kind as MerchantCleanupKind)
    ? (parsed.kind as MerchantCleanupKind)
    : 'product';

  // Defensive: kind=product with empty clean_description is the LLM
  // contradicting itself — fall back to the raw input.
  const cleanRaw = typeof parsed.clean_description === 'string' ? parsed.clean_description.trim() : '';
  const effectiveClean =
    cleanRaw && kind !== 'merchant_shorthand' && kind !== 'ungrounded'
      ? cleanRaw
      : kind === 'product'
        ? trimmed
        : '';

  return {
    invoked: 'llm',
    kind,
    effective: effectiveClean || trimmed,
    attributes: coerceStringArray(parsed.attributes, 6),
    stripped: coerceStringArray(parsed.stripped, 16),
    latencyMs: llmTrace.latency_ms,
    model,
  };
}
