/**
 * Merchant-input cleanup. Strips brand / SKU / marketing noise before
 * retrieval via a deterministic short-circuit then a Haiku extraction call.
 */
import { z } from 'zod';
import { structuredLlmCall } from '../llm/structured-call.js';
import { env } from '../config/env.js';
import type { MerchantCleanupKind } from '../types/domain.js';
export type { MerchantCleanupKind } from '../types/domain.js';

export interface MerchantCleanupResult {
  invoked: 'skipped_clean' | 'llm' | 'llm_failed' | 'llm_unparseable';
  /** Only meaningful when invoked='llm'. */
  kind: MerchantCleanupKind;
  /** Falls back to raw input on skip/failure — pipeline never blocks on cleanup. */
  effective: string;
  attributes: string[];
  stripped: string[];
  /** Populated only when kind='multi_product'. Each item is a short label. */
  products: string[];
  latencyMs: number;
  model?: string | undefined;
}

/** True when input is already broker-grade and cleanup can be skipped. */
export function looksClean(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return true;
  if (trimmed.length > 80) return false;

  const tokens = trimmed.split(/\s+/);
  if (tokens.length > 4) return false;
  if (/B0[A-Z0-9]{8}/.test(trimmed)) return false;
  if (/[,(){}[\]/]/.test(trimmed)) return false;

  for (const tok of tokens) {
    const cleaned = tok.replace(/[^A-Za-z0-9]/g, '');
    if (cleaned.length < 2) continue;
    if (/\d/.test(cleaned) && /[A-Za-z]/.test(cleaned)) {
      // 4+ chars = model code; 2-3 chars only if ends in digit (excludes "3D", "1st").
      if (cleaned.length >= 4 || /\d$/.test(cleaned)) return false;
    }
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
    products: z.unknown().optional(),
  })
  .passthrough();

const KIND_VALUES = new Set<MerchantCleanupKind>([
  'product',
  'merchant_shorthand',
  'ungrounded',
  'multi_product',
]);

function coerceStringArray(v: unknown, max = 16): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 200)
    .slice(0, max);
}

export interface CleanupOpts {
  /** Default 200. */
  maxTokens?: number;
  /** Defaults to env LLM_MODEL. */
  model?: string;
}

/** Run cleanup on a raw merchant description. Never throws on LLM failure. */
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
      products: [],
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
    timeoutMs: 8_000,
  });

  if (outcome.kind === 'llm_failed') {
    return {
      invoked: 'llm_failed',
      kind: 'product',
      effective: trimmed,
      attributes: [],
      stripped: [],
      products: [],
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
      products: [],
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
  const effectiveClean =
    cleanRaw && kind === 'product'
      ? cleanRaw
      : kind === 'product'
        ? trimmed
        : '';

  // products[] only meaningful for multi_product; ignored on other kinds.
  const products =
    kind === 'multi_product' ? coerceStringArray(parsed.products, 8) : [];

  return {
    invoked: 'llm',
    kind,
    effective: effectiveClean || trimmed,
    attributes: coerceStringArray(parsed.attributes, 6),
    stripped: coerceStringArray(parsed.stripped, 16),
    products,
    latencyMs: llmTrace.latency_ms,
    model,
  };
}
