/**
 * Merchant-input cleanup — Phase 1.5 of the v3 alternatives redesign.
 *
 * Strips brand/SKU/marketing noise from raw merchant descriptions BEFORE
 * retrieval, so the embedder + RRF + picker see customs-relevant signal
 * only. The cheaper sibling of `research-input.md` (which fires reactively
 * after retrieval fails); this fires proactively on inputs that look noisy.
 *
 * Two layers:
 *
 *   1. Deterministic "is this already clean?" check. ≤4 words, no SKU
 *      pattern, no brand-list match, no obvious marketing-string punctuation
 *      → pass through unchanged. Saves an LLM call on the ~80% of merchant
 *      descriptions that are already 1–3 word stubs ("Hair Clip", "Cards",
 *      "Coat") per the sample-2 distribution.
 *
 *   2. Haiku call (LLM_MODEL, the weak model) on noisy inputs. Returns
 *      structured JSON with `clean_description`, `attributes`, `stripped`,
 *      and `kind ∈ {product, merchant_shorthand, ungrounded}`. The kind
 *      field tells the caller whether to feed the cleaned text into
 *      retrieval, fire the researcher, or short-circuit to
 *      needs_clarification.
 *
 * Why Haiku not Sonnet: this is structured cleanup, not legal reasoning.
 * Haiku is faster (~1.5s vs ~3-5s) and ~10× cheaper, and the worst-case
 * failure is a downstream re-classification — bounded blast radius.
 */
import { z } from 'zod';
import { structuredLlmCall } from '../llm/structured-call.js';
import { env } from '../config/env.js';

export type MerchantCleanupKind = 'product' | 'merchant_shorthand' | 'ungrounded';

export interface MerchantCleanupResult {
  /** Whether the LLM ran or we short-circuited deterministically. */
  invoked: 'skipped_clean' | 'llm' | 'llm_failed' | 'llm_unparseable';
  /** Final classification of the input (only meaningful when invoked='llm'). */
  kind: MerchantCleanupKind;
  /**
   * The text to feed downstream. When the input was already clean OR the LLM
   * call failed, this equals the original raw input — we never block the
   * pipeline on cleanup failure.
   */
  effective: string;
  /** Customs-relevant attributes the LLM extracted (empty when skipped/failed). */
  attributes: string[];
  /** Tokens stripped (empty when skipped — we trust the deterministic path). */
  stripped: string[];
  /** LLM round-trip latency in ms; 0 when we skipped. */
  latencyMs: number;
  /** Optional model identifier (for logging). */
  model?: string | undefined;
}

/**
 * Heuristic: does this input look "clean enough" to skip cleanup?
 *
 *   - ≤ 4 whitespace-separated tokens
 *   - no Amazon ASIN (B0XXXXXXXX)
 *   - no obvious model code (4+ chars mixing digits and letters)
 *   - no comma (commas are a strong signal of stitched-together listing titles)
 *   - no parenthesis (same — "(International Version)", "(200 ml)")
 *
 * If any of these fail, we send it to the LLM. This gives us a
 * very high precision short-circuit: if it passes all checks, the
 * input is essentially already what a customs broker would type.
 */
export function looksClean(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return true; // empty input is "clean" — caller handles emptiness
  if (trimmed.length > 80) return false;

  const tokens = trimmed.split(/\s+/);
  if (tokens.length > 4) return false;

  if (/B0[A-Z0-9]{8}/.test(trimmed)) return false;
  if (/[,(){}[\]/]/.test(trimmed)) return false;

  // Mixed alphanumeric with 4+ chars and at least 1 digit + 1 letter
  // Captures "WH-1000XM5", "MUF-128BE4", "Mocca43", etc.
  // Allow standalone numbers ("3", "200") and standalone words ("smartphone").
  for (const tok of tokens) {
    const cleaned = tok.replace(/[^A-Za-z0-9]/g, '');
    if (cleaned.length < 4) continue;
    const hasDigit = /\d/.test(cleaned);
    const hasLetter = /[A-Za-z]/.test(cleaned);
    if (hasDigit && hasLetter) return false;
  }

  return true;
}

// Loose schema — fields are validated downstream because the LLM sometimes
// outputs `null` or omits fields entirely; the post-extraction code coerces
// to defaults rather than failing the schema.
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

  // Layer 1: deterministic short-circuit.
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

  // Layer 2: LLM cleanup. Use the weak model (Haiku) — this is structured
  // extraction, not legal reasoning.
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

  if (outcome.kind === 'llm_failed') {
    return {
      invoked: 'llm_failed',
      kind: 'product', // benign default — caller will use `effective`
      effective: trimmed, // never block the pipeline on cleanup failure
      attributes: [],
      stripped: [],
      latencyMs: outcome.trace.latency_ms,
      model,
    };
  }
  if (outcome.kind !== 'ok') {
    // unparseable / schema_invalid — same fallback shape
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

  const cleanRaw = typeof parsed.clean_description === 'string' ? parsed.clean_description.trim() : '';
  // If the LLM returned an empty clean_description for kind=product, it's
  // contradicting itself — treat as 'ungrounded' so the caller can decide.
  // This is defensive: a coherent product input should always yield a non-empty
  // clean_description.
  const effectiveClean =
    cleanRaw && kind !== 'merchant_shorthand' && kind !== 'ungrounded'
      ? cleanRaw
      : kind === 'product'
        ? trimmed // fallback — LLM contradicted itself, ship the original
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
