/**
 * Phase 5 — ZATCA-safe submission description. ZATCA rejects declarations
 * whose Arabic text matches the catalog AR word-for-word; this module
 * generates a fluent variant that differs by at least one token.
 *
 * Anchored on EFFECTIVE description (cleaned/researched), not raw input —
 * prevents brand/SKU re-leaking into the declaration.
 *
 * Two-attempt LLM loop with deterministic distinctness check after each.
 * Final fallback is a prefix-mutator that always passes the rule (broker
 * may edit the rough output rather than ship nothing).
 */
import { z } from 'zod';
import { structuredLlmCall } from '../llm/structured-call.js';
import { env } from '../config/env.js';

export interface SubmissionDescriptionResult {
  invoked: 'disabled' | 'llm' | 'llm_failed' | 'guard_fallback';
  /** Always non-empty when invoked != 'disabled'. */
  descriptionAr: string;
  /** Independently generated, not translated from AR. */
  descriptionEn: string;
  rationale: string;
  /** Passed the "differs from catalog AR" check. UI shows a green badge. */
  differsFromCatalog: boolean;
  /** Total across retries; 0 when skipped. */
  latencyMs: number;
  model?: string | undefined;
}

const ParsedSubmissionSchema = z
  .object({
    description_ar: z.unknown().optional(),
    description_en: z.unknown().optional(),
    rationale: z.unknown().optional(),
  })
  .passthrough();

/**
 * Normalise Arabic for the distinctness check: NFKC (keeps أ composed —
 * NFKD would split letter+hamza and the diacritic stripper would then
 * falsely match أحذية ↔ احذية), strip diacritics + bidi marks + tree
 * formatting punctuation, collapse whitespace.
 */
function normalizeAr(s: string): string {
  if (!s) return '';
  let out = s.normalize('NFKC');
  // Arabic harakat U+064B–U+0652 + superscript alef U+0670
  out = out.replace(/[ً-ْٰ]/g, '');
  // Bidi formatting characters (LRM/RLM/PDF/LRE/RLE/LRO/RLO/FSI/LRI/RLI/PDI)
  out = out.replace(/[​-‏‪-‮⁦-⁩﻿]/g, '');
  out = out.replace(/^[\s\-·.•]+|[\s\-·.•]+$/g, '');
  out = out.replace(/\s+/g, ' ').trim();
  return out;
}

/** Returns true if the LLM's AR output is acceptably distinct from the catalog AR. */
function passesDistinctnessCheck(generatedAr: string, catalogAr: string | null): boolean {
  if (!catalogAr) return true; // no catalog to compare against → trivially passes
  const a = normalizeAr(generatedAr);
  const b = normalizeAr(catalogAr);
  if (!a) return false; // empty generation never passes
  return a !== b;
}

/**
 * Deterministic last-resort fallback — when the LLM has failed twice (or
 * the call itself failed). Builds an Arabic description that differs from
 * the catalog by prepending a customs-relevant word from the user's
 * effective description.
 *
 * This is intentionally rough — better to ship something the broker can
 * edit than nothing. The frontend should display a "auto-generated
 * fallback, please review" warning when `invoked === 'guard_fallback'`.
 */
function buildFallback(effectiveDescription: string, catalogAr: string | null): {
  descriptionAr: string;
  descriptionEn: string;
} {
  // Pick the first attribute-rich word from the effective description as
  // the prefix. Skip very short tokens and common stopwords.
  const STOP = new Set(['a', 'an', 'the', 'of', 'for', 'with', 'and', 'or']);
  const tokens = effectiveDescription
    .split(/[\s,;]+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= 3 && !STOP.has(t));
  const prefix = tokens[0] ?? 'general';

  // Crude transliteration map for the most common product-class prefixes
  // we see in merchant data. If a token isn't in here, ship the latin
  // word as-is — the broker will edit. Better than blank.
  const TRANSLIT: Record<string, string> = {
    bluetooth: 'بلوتوث',
    wireless: 'لاسلكية',
    wired: 'سلكية',
    cotton: 'قطنية',
    leather: 'جلدية',
    plastic: 'بلاستيكية',
    metal: 'معدنية',
    smart: 'ذكية',
    digital: 'رقمية',
    electric: 'كهربائية',
    automatic: 'أوتوماتيكية',
  };
  const arPrefix = TRANSLIT[prefix] ?? prefix;
  const cleanCatalogAr = catalogAr ? normalizeAr(catalogAr) : 'منتج';

  return {
    descriptionAr: `${arPrefix} ${cleanCatalogAr}`,
    descriptionEn: `${prefix} ${effectiveDescription}`.slice(0, 80),
  };
}

export interface SubmissionDescriptionOpts {
  enabled?: boolean;
  /** Default 300. */
  maxTokens?: number;
  /** Defaults to env LLM_MODEL_STRONG. */
  model?: string;
}

export interface GenerateSubmissionParams {
  effectiveDescription: string;
  chosenCode: string;
  catalogDescriptionAr: string | null;
  catalogDescriptionEn: string | null;
  opts?: SubmissionDescriptionOpts;
}

function disabled(): SubmissionDescriptionResult {
  return {
    invoked: 'disabled',
    descriptionAr: '',
    descriptionEn: '',
    rationale: '',
    differsFromCatalog: false,
    latencyMs: 0,
  };
}

/** Always returns a result; never throws — falls back to prefix mutator on LLM failure. */
export async function generateSubmissionDescription(
  params: GenerateSubmissionParams,
): Promise<SubmissionDescriptionResult> {
  const { effectiveDescription, chosenCode, catalogDescriptionAr, catalogDescriptionEn, opts = {} } = params;
  // 150 tokens fits the JSON envelope (description_ar + description_en +
  // rationale, all short product-text). Lower max_tokens reduces both the
  // generation budget and Anthropic's TTFT — submission is one of two LLM
  // calls on the accepted path's critical path, so trimming it pays back.
  const { enabled = true, maxTokens = 150 } = opts;

  if (!enabled) return disabled();

  const e = env();
  const model = opts.model ?? e.LLM_MODEL_STRONG;

  const userPrompt = (extraHint?: string): string => {
    const lines = [
      `Effective product description: ${effectiveDescription}`,
      `Chosen HS code: ${chosenCode}`,
      `Catalog Arabic description (DO NOT replicate exactly): ${catalogDescriptionAr ?? '(none)'}`,
      `Catalog English description (for reference): ${catalogDescriptionEn ?? '(none)'}`,
    ];
    if (extraHint) lines.push('', extraHint);
    lines.push('', 'Return JSON only.');
    return lines.join('\n');
  };

  let totalLatency = 0;
  let lastModel = model;

  // Try once, then retry once with a stricter hint if the first output
  // failed the distinctness check.
  for (const attempt of [1, 2] as const) {
    const hint =
      attempt === 1
        ? undefined
        : 'Your previous output was a word-for-word match with the catalog Arabic description. Generate a different phrasing — add at least one customs-relevant word, change word order, or use a synonymous noun-form.';

    const outcome = await structuredLlmCall({
      promptFile: 'submission-description.md',
      user: userPrompt(hint),
      schema: ParsedSubmissionSchema,
      stage: 'submission_description',
      model,
      maxTokens,
      temperature: attempt === 1 ? 0 : 0.2,
    });
    totalLatency += outcome.trace.latency_ms;
    lastModel = outcome.trace.model;

    if (outcome.kind !== 'ok') continue; // retry or fall through to deterministic fallback
    const parsed = outcome.data;

    const descAr = typeof parsed.description_ar === 'string' ? parsed.description_ar.trim() : '';
    const descEn = typeof parsed.description_en === 'string' ? parsed.description_en.trim() : '';
    const rationale =
      typeof parsed.rationale === 'string' ? parsed.rationale.slice(0, 300) : '';

    if (!descAr || !descEn) continue;

    if (passesDistinctnessCheck(descAr, catalogDescriptionAr)) {
      return {
        invoked: 'llm',
        descriptionAr: descAr,
        descriptionEn: descEn,
        rationale: rationale || `Generated submission text differs from the catalog AR while preserving the product type from the user's input.`,
        differsFromCatalog: true,
        latencyMs: totalLatency,
        model: lastModel,
      };
    }
    // Else: try again on attempt 2.
  }

  // Deterministic last-resort fallback — guarantees we ship something.
  const fb = buildFallback(effectiveDescription, catalogDescriptionAr);
  return {
    invoked: 'guard_fallback',
    descriptionAr: fb.descriptionAr,
    descriptionEn: fb.descriptionEn,
    rationale: 'Auto-generated fallback — LLM output matched the catalog AR. Please review before submission.',
    differsFromCatalog: passesDistinctnessCheck(fb.descriptionAr, catalogDescriptionAr),
    latencyMs: totalLatency,
    model: lastModel,
  };
}

// Exported for unit testing.
export const __test__ = { normalizeAr, passesDistinctnessCheck, buildFallback };
