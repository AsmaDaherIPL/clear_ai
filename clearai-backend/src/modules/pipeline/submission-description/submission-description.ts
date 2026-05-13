/**
 * Stage 2.5 — Submission description (lightweight LLM, pure-LLM, no cache).
 *
 * After Reconciliation accepts a final 12-digit HS code, ZATCA needs an
 * Arabic goods description for the declaration envelope. The only hard
 * ZATCA rule is "no exact word-for-word match with the catalog leaf
 * Arabic" — reusing catalog vocabulary is fine, even encouraged for
 * tariff fidelity. The goal is a meaningful Arabic description of THIS
 * specific item, not a paraphrase contest with the catalog.
 *
 * Inputs to the LLM:
 *   • cleaned_description (the item itself, primary signal)
 *   • item_description (raw merchant input, supporting signal for brand/type/capacity)
 *   • chosenCode (12-digit)
 *   • catalog leaf Arabic     — vocabulary the LLM can borrow from
 *   • catalog leaf English    — cross-reference
 *   • path Arabic breadcrumb  — chapter > heading > hs6 > leaf, gives category context
 *   • path English breadcrumb — cross-reference
 *
 * Constraints:
 *   • Arabic only
 *   • ≤300 chars
 *   • Must NOT exactly equal the catalog leaf Arabic (post NFKC + whitespace
 *     normalisation). Adding a single meaningful word from the item is
 *     enough; fabricating attributes that aren't in the input is not.
 *
 * Never throws. On LLM failure, returns a deterministic fallback:
 *   <first content word from cleaned_description> + ' ' + <leaf catalog Ar>
 *   — distinct from the catalog AND carries the item-specific signal.
 */
import { z } from 'zod';
import { structuredLlmCall } from '../../../inference/llm/structured-call.js';
import { getLlmStagePolicy } from '../../../inference/llm/policy.js';
import { env } from '../../../config/env.js';

export interface SubmissionDescriptionResult {
  invoked: 'llm' | 'llm_failed' | 'fallback' | 'fallback_after_collision';
  /** ZATCA-safe Arabic description, ≤300 chars. Always non-empty. */
  descriptionAr: string;
  latencyMs: number;
  model?: string | undefined;
  /** Total LLM attempts including the first call (>=1). */
  attempts: number;
  /** Reason recorded for each attempt that triggered a parse retry. */
  retried_reasons?: string[];
}

const MAX_CHARS = 300;

const ParsedSchema = z
  .object({
    description_ar: z.unknown().optional(),
  })
  .passthrough();

/** NFKC + collapse whitespace + cap. */
function normalize(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/** Equality check used to enforce the no-verbatim-leaf rule. */
function equalsLeaf(generated: string, leafAr: string | null): boolean {
  if (!leafAr) return false;
  return normalize(generated) === normalize(leafAr);
}

/**
 * Deterministic fallback. Picks the first non-trivial token from the
 * cleaned description and prefixes it to the catalog leaf Arabic — this
 * is guaranteed:
 *   (a) non-empty
 *   (b) different from the leaf verbatim (extra prefix word)
 *   (c) tied to the actual item (not a synthetic placeholder)
 *
 * If catalog leaf Arabic is missing, falls back to the path-Ar leaf
 * segment, then to a synthetic "<token> منتج" string.
 */
function buildFallback(cleanedDescription: string, leafAr: string | null, pathAr: string | null): string {
  const STOP = new Set(['a', 'an', 'the', 'of', 'for', 'with', 'and', 'or', 'is', 'in', 'on']);
  const token = cleanedDescription
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .find((t) => t.length >= 2 && !STOP.has(t.toLowerCase())) ?? cleanedDescription.trim();

  const anchor = (leafAr && normalize(leafAr)) || (() => {
    if (!pathAr) return '';
    const parts = pathAr.split('>').map((p) => p.trim()).filter(Boolean);
    return parts[parts.length - 1] ?? '';
  })();

  const prefix = token.slice(0, 60);
  const tail = anchor || 'منتج';
  return normalize(`${prefix} ${tail}`).slice(0, MAX_CHARS);
}

export interface GenerateSubmissionParams {
  /** The cleaned item description from Stage 1. */
  cleanedDescription: string;
  /**
   * The merchant's verbatim input (post Stage-0a parse, before Stage-0b
   * cleanup stripping). Supporting signal for brand names, product
   * type/model, and merchant-stated attributes (capacity, SPF, gender)
   * that cleanup may have stripped. The cleaned form is the primary
   * signal for category/type.
   */
  rawDescription: string;
  /** The 12-digit HS code accepted by Stage 2 (Reconciliation). */
  chosenCode: string;
  /** zatca_hs_codes.description_ar for the chosen code. */
  catalogLeafAr: string | null;
  /** zatca_hs_codes.description_en for the chosen code. */
  catalogLeafEn: string | null;
  /** zatca_hs_code_display.path_ar — chapter > heading > hs6 > leaf, Arabic. */
  catalogPathAr: string | null;
  /** zatca_hs_code_display.path_en — same path, English. */
  catalogPathEn: string | null;
  /** Override model. Defaults to lightweight env LLM_MODEL. */
  model?: string;
}

export async function generateSubmissionDescription(
  params: GenerateSubmissionParams,
): Promise<SubmissionDescriptionResult> {
  const {
    cleanedDescription,
    rawDescription,
    chosenCode,
    catalogLeafAr,
    catalogLeafEn,
    catalogPathAr,
    catalogPathEn,
  } = params;

  const model = params.model ?? env().LLM_MODEL;

  const user = JSON.stringify({
    item_description: rawDescription,
    cleaned_description: cleanedDescription,
    hs_code: chosenCode,
    catalog_leaf_ar: catalogLeafAr,
    catalog_leaf_en: catalogLeafEn,
    catalog_path_ar: catalogPathAr,
    catalog_path_en: catalogPathEn,
    max_chars: MAX_CHARS,
  });

  const policy = getLlmStagePolicy('submission_description');
  const outcome = await structuredLlmCall({
    promptFile: 'submission-description.md',
    user,
    schema: ParsedSchema,
    stage: 'submission_description',
    model,
    maxTokens: 500,
    temperature: 0,
    timeoutMs: policy.timeoutMs,
    parseRetryPolicy: {
      enabled: true,
      maxAttempts: policy.maxAttempts,
      totalBudgetMs: policy.totalBudgetMs,
    },
  });

  const attempts = outcome.trace.attempts ?? 1;
  const retried_reasons = outcome.trace.retried_reasons;
  const traceMeta = retried_reasons && retried_reasons.length > 0 ? { retried_reasons } : {};

  if (outcome.kind !== 'ok') {
    return {
      invoked: 'llm_failed',
      descriptionAr: buildFallback(cleanedDescription, catalogLeafAr, catalogPathAr),
      latencyMs: outcome.trace.latency_ms,
      model: outcome.trace.model,
      attempts,
      ...traceMeta,
    };
  }

  const raw = typeof outcome.data.description_ar === 'string' ? outcome.data.description_ar : '';
  const cleaned = normalize(raw).slice(0, MAX_CHARS);

  if (!cleaned) {
    return {
      invoked: 'fallback',
      descriptionAr: buildFallback(cleanedDescription, catalogLeafAr, catalogPathAr),
      latencyMs: outcome.trace.latency_ms,
      model: outcome.trace.model,
      attempts,
      ...traceMeta,
    };
  }

  if (equalsLeaf(cleaned, catalogLeafAr)) {
    return {
      invoked: 'fallback_after_collision',
      descriptionAr: buildFallback(cleanedDescription, catalogLeafAr, catalogPathAr),
      latencyMs: outcome.trace.latency_ms,
      model: outcome.trace.model,
      attempts,
      ...traceMeta,
    };
  }

  return {
    invoked: 'llm',
    descriptionAr: cleaned,
    latencyMs: outcome.trace.latency_ms,
    model: outcome.trace.model,
    attempts,
    ...traceMeta,
  };
}

// Exported for unit testing.
export const __test__ = { normalize, equalsLeaf, buildFallback };
