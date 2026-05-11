/**
 * Description-cleanup. Strips brand / SKU / marketing noise from a raw user
 * input before retrieval, via a deterministic short-circuit then a Haiku
 * extraction call.
 *
 * Renamed from merchant-cleanup (the tool isn't merchant-only — brokers,
 * end-users, batch importers all hit the same surface).
 *
 * Pipeline contract (new-pipeline / ADR-pending):
 *   • Always invoked when DESCRIPTION_CLEANUP_ENABLED=1 (kill-switch).
 *   • Output `kind` decides downstream routing:
 *       'product'             → continue to retrieval
 *       'merchant_shorthand'  → skip retrieval, route to Researcher
 *       'ungrounded'          → skip retrieval, route to Researcher
 *       'multi_product'       → refuse with multi_product_input reason
 *   • `nounGrounded` mirrors the kind decision in a single boolean for
 *     callers that just need "did we recover a customs noun?" without
 *     pattern-matching on the full kind enum.
 *   • `typoCorrections` records single-word typo fixes (heals→heels,
 *     shooes→shoes) for the audit trail. Empty array on no correction.
 *
 * Failure mode: never throws. LLM failures degrade to the raw input being
 * passed downstream — better a slightly noisier retrieval than a 5xx.
 */
import { z } from 'zod';
import { structuredLlmCall } from '../../../inference/llm/structured-call.js';
import { env } from '../../../config/env.js';
import type { DescriptionCleanupKind } from '../shared/domain.types.js';
export type { DescriptionCleanupKind } from '../shared/domain.types.js';

/** A single typo correction emitted by the LLM (e.g. heals → heels). */
export interface TypoCorrection {
  from: string;
  to: string;
}

export interface DescriptionCleanupResult {
  invoked: 'skipped_clean' | 'llm' | 'llm_failed' | 'llm_unparseable';
  /** Only meaningful when invoked='llm'. */
  kind: DescriptionCleanupKind;
  /** Falls back to raw input on skip/failure — pipeline never blocks on cleanup. */
  effective: string;
  attributes: string[];
  stripped: string[];
  /** Populated only when kind='multi_product'. Each item is a short label. */
  products: string[];
  /** True iff cleanup recovered a real customs noun (mirrors kind='product'). */
  nounGrounded: boolean;
  /** Single-word typo fixes applied to clean_description, if any. */
  typoCorrections: TypoCorrection[];
  /**
   * Tariff-vocabulary English re-expression of the input — only emitted by
   * the LLM when the source input is non-English. Engineered to land closer
   * to ZATCA catalog phrasings than a literal translation would (e.g.
   * "هودي محبوك" → "knitted pullover with hood, of cotton or synthetic
   * fibres" rather than "knitted hoodie"). Track A retrieval prefers this
   * over `effective` when present, because the catalog itself speaks tariff
   * English. Empty string for English input or when the LLM declined to
   * produce one.
   */
  tariffExpansionEn: string;
  latencyMs: number;
  model?: string | undefined;
}

/**
 * Generic shipping nouns that describe a CONTAINER, not a product.
 * If the input boils down to one of these, retrieval will pattern-match
 * the noun itself ("parcel" → trgm-hits chapter 48 paper packaging, etc.)
 * and the picker has nothing real to choose from. Force the LLM cleanup
 * pass so these classify as `ungrounded` and the Researcher fires.
 */
const GENERIC_SHIPPING_NOUNS = new Set([
  'parcel', 'parcels',
  'item', 'items',
  'shipment', 'shipments',
  'goods', 'good',
  'product', 'products',
  'box', 'boxes',
  'package', 'packages',
  'cargo',
  'merchandise',
  'commodity', 'commodities',
  'consignment',
  'freight',
  'unit', 'units',
  'piece', 'pieces',
  'sample', 'samples',
  'gift', 'gifts',
  'document', 'documents',
  'letter', 'letters',
  'envelope', 'envelopes',
]);

/**
 * Stop words filtered out before the deny-list check. These don't
 * rescue an otherwise generic input: "small parcel" and "box of items"
 * are still nothing-but-containers once these are removed.
 */
const SHIPPING_STOPWORDS = new Set([
  'a', 'an', 'the',
  'of', 'in', 'on', 'with', 'and', 'or', 'for',
  'small', 'medium', 'large', 'big',
  'one', 'two', 'three',
]);

/**
 * True when input is already broker-grade and cleanup can be skipped.
 *
 * Conservative — false-positive (running cleanup unnecessarily) costs
 * ~$0.0001 + ~150ms; false-negative (skipping when input had noise) means
 * retrieval gets the noise. Tilt toward running cleanup when in doubt.
 */
export function looksClean(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return true;
  if (trimmed.length > 80) return false;

  const tokens = trimmed.split(/\s+/);
  if (tokens.length > 4) return false;
  if (/B0[A-Z0-9]{8}/.test(trimmed)) return false;
  if (/[,(){}[\]/]/.test(trimmed)) return false;

  // Generic-shipping-noun gate: drop stop-words ("of", "small", "1"),
  // then if every remaining alphabetic token is a generic container
  // noun, this isn't a product description. Force the LLM cleanup
  // so it classifies as `ungrounded` and the Researcher fires.
  const contentTokens = tokens
    .map((t) => t.replace(/[^A-Za-z]/g, '').toLowerCase())
    .filter((t) => t.length >= 2 && !SHIPPING_STOPWORDS.has(t));
  if (
    contentTokens.length > 0 &&
    contentTokens.every((t) => GENERIC_SHIPPING_NOUNS.has(t))
  ) {
    return false;
  }

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

/** Loose schema — fields validated by post-extraction code, not Zod. */
const ParsedCleanupSchema = z
  .object({
    kind: z.unknown().optional(),
    clean_description: z.unknown().optional(),
    attributes: z.unknown().optional(),
    stripped: z.unknown().optional(),
    products: z.unknown().optional(),
    noun_grounded: z.unknown().optional(),
    typo_corrections: z.unknown().optional(),
    tariff_expansion_en: z.unknown().optional(),
  })
  .passthrough();

const KIND_VALUES = new Set<DescriptionCleanupKind>([
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

/**
 * Parse the LLM-emitted typo_corrections field into a typed array.
 * Defensive against malformed shapes — drops anything that isn't
 * { from: string, to: string } with both non-empty/different/bounded.
 */
function coerceTypoCorrections(v: unknown): TypoCorrection[] {
  if (!Array.isArray(v)) return [];
  const out: TypoCorrection[] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const from = typeof obj['from'] === 'string' ? obj['from'].trim() : '';
    const to = typeof obj['to'] === 'string' ? obj['to'].trim() : '';
    // Both must be non-empty, different, and bounded. Drop nonsense like
    // {from: "", to: "shoes"} or {from: "shoes", to: "shoes"} (no-op).
    if (from && to && from !== to && from.length < 64 && to.length < 64) {
      out.push({ from, to });
    }
    if (out.length >= 8) break;
  }
  return out;
}

export interface CleanupOpts {
  /** Default 200. */
  maxTokens?: number;
  /** Defaults to env LLM_MODEL. */
  model?: string;
}

/**
 * Run cleanup on a raw user description. Never throws on LLM failure.
 *
 * Returns a DescriptionCleanupResult that the route layer uses to decide
 * routing (product → retrieval, merchant_shorthand/ungrounded → Researcher,
 * multi_product → refusal).
 */
export async function cleanDescription(
  rawInput: string,
  opts: CleanupOpts = {},
): Promise<DescriptionCleanupResult> {
  const trimmed = rawInput.trim();

  if (looksClean(trimmed)) {
    return {
      invoked: 'skipped_clean',
      kind: 'product',
      effective: trimmed,
      attributes: [],
      stripped: [],
      products: [],
      nounGrounded: true,
      typoCorrections: [],
      tariffExpansionEn: '',
      latencyMs: 0,
    };
  }

  const e = env();
  const model = opts.model ?? e.LLM_MODEL;
  const maxTokens = opts.maxTokens ?? 200;

  const outcome = await structuredLlmCall({
    promptFile: 'description-cleanup.md',
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
      nounGrounded: false,
      typoCorrections: [],
      tariffExpansionEn: '',
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
      nounGrounded: false,
      typoCorrections: [],
      tariffExpansionEn: '',
      latencyMs: outcome.trace.latency_ms,
      model,
    };
  }
  const parsed = outcome.data;
  const llmTrace = outcome.trace;

  const kind: DescriptionCleanupKind = KIND_VALUES.has(parsed.kind as DescriptionCleanupKind)
    ? (parsed.kind as DescriptionCleanupKind)
    : 'product';

  const cleanRaw =
    typeof parsed.clean_description === 'string' ? parsed.clean_description.trim() : '';
  const effectiveClean =
    cleanRaw && kind === 'product'
      ? cleanRaw
      : kind === 'product'
        ? trimmed
        : '';

  // products[] only meaningful for multi_product; ignored on other kinds.
  const products =
    kind === 'multi_product' ? coerceStringArray(parsed.products, 8) : [];

  // noun_grounded: trust the LLM-emitted field if present and boolean,
  // otherwise derive from kind. Defensive in both directions.
  const llmNounGrounded =
    typeof parsed.noun_grounded === 'boolean' ? parsed.noun_grounded : null;
  const derivedNounGrounded = kind === 'product' && effectiveClean.length > 0;
  const nounGrounded = llmNounGrounded ?? derivedNounGrounded;

  const typoCorrections = coerceTypoCorrections(parsed.typo_corrections);

  // tariff_expansion_en — optional LLM-emitted English re-expression of the
  // input using tariff vocabulary. The LLM is instructed to only produce it
  // when the input is non-English; for English input the field is absent or
  // empty. Defensive: cap length, trim, drop anything non-string. Empty
  // string means "no expansion available" — Track A retrieval falls back
  // to `effective`.
  const tariffExpansionRaw =
    typeof parsed.tariff_expansion_en === 'string' ? parsed.tariff_expansion_en.trim() : '';
  const tariffExpansionEn =
    tariffExpansionRaw.length > 0 && tariffExpansionRaw.length < 400 ? tariffExpansionRaw : '';

  return {
    invoked: 'llm',
    kind,
    effective: effectiveClean || trimmed,
    attributes: coerceStringArray(parsed.attributes, 6),
    stripped: coerceStringArray(parsed.stripped, 16),
    products,
    nounGrounded,
    typoCorrections,
    tariffExpansionEn,
    latencyMs: llmTrace.latency_ms,
    model,
  };
}

