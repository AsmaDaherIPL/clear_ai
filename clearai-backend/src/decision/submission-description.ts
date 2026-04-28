/**
 * Submission description generator — Phase 5 of the v3 alternatives redesign.
 *
 * Generates a 1–3 word Arabic submission description that the broker can
 * paste directly into a ZATCA declaration field. ZATCA rejects submissions
 * whose Arabic description matches the catalog description for the chosen
 * HS code WORD-FOR-WORD; this module produces a fluent, attribute-led
 * variant that differs by at least one token while remaining true to the
 * user's product.
 *
 * Anchoring rule: the input to the LLM is the EFFECTIVE description (the
 * cleaned-up product type after Phase 1.5 cleanup or the researcher's
 * canonical phrase, whichever applies), NOT the raw user input. Otherwise
 * a "Samsung Galaxy S25 Ultra B0DP3GDTCF" input would feed the SKU back
 * into the customs declaration, which is exactly what we don't want.
 *
 * Defensive checks (deterministic, run after the LLM):
 *   1. Output AR (whitespace + diacritic normalised) MUST NOT equal the
 *      catalog AR. Regenerate once with a stricter hint if it does.
 *   2. After two failed attempts, fall back to a deterministic prefix
 *      mutator: prepend the most attribute-rich word from the user input
 *      (or a generic qualifier) to the catalog AR. Always passes ZATCA's
 *      word-for-word rule, even if the prose is rough — better to ship
 *      something the broker can edit than nothing.
 *
 * Feature-flagged via setup_meta.SUBMISSION_DESC_ENABLED. Default 1
 * because this is the explicit broker-facing requirement that drove the
 * Phase 5 design — but we keep the flag so it can be turned off per-route
 * or for A/B testing without redeploy.
 */
import { z } from 'zod';
import { structuredLlmCall } from '../llm/structured-call.js';
import { env } from '../config/env.js';

export interface SubmissionDescriptionResult {
  /** Whether the LLM ran or we short-circuited. */
  invoked: 'disabled' | 'llm' | 'llm_failed' | 'guard_fallback';
  /** Final Arabic description shipped to the user. Always non-empty when invoked != 'disabled'. */
  descriptionAr: string;
  /** Final English description (LLM-generated independently, not a translation). */
  descriptionEn: string;
  /** One-sentence rationale from the LLM (or auto-generated for fallbacks). */
  rationale: string;
  /**
   * True iff the final descriptionAr passes the deterministic
   * "differs from catalog AR by at least one token" check. Used by the
   * frontend to render a "✓ Differs from ZATCA catalog" badge.
   */
  differsFromCatalog: boolean;
  /** LLM round-trip latency in ms across retries; 0 when skipped. */
  latencyMs: number;
  /** Optional model identifier. */
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
 * Normalise an Arabic string for the "differs from catalog" check:
 *   - strip Arabic diacritics (تشكيل) so "هاتف" matches "هَاتِف"
 *   - collapse whitespace
 *   - trim
 *   - strip leading/trailing punctuation that the catalog uses for tree
 *     formatting (e.g. " - - " prefixes) so semantically-empty differences
 *     aren't counted as different
 */
function normalizeAr(s: string): string {
  if (!s) return '';
  // NFKC keeps composed forms intact: أ (U+0623 ALEF WITH HAMZA ABOVE) stays
  // as a single codepoint instead of decomposing into ا + ٔ. NFKD would split
  // letter+hamza pairs into base+combining and our diacritic stripper would
  // then drop the hamza, falsely making "أحذية" and "احذية" compare equal.
  // For the customs distinctness check we want composed-form equality.
  let out = s.normalize('NFKC');
  // Combining diacritics range U+064B–U+0652 (Arabic harakat) + U+0670 (superscript alef)
  out = out.replace(/[ً-ْٰ]/g, '');
  // Strip bidirectional formatting characters (LRM, RLM, LRE/RLE/PDF/LRO/RLO,
  // FSI/LRI/RLI/PDI). These are invisible markers that often hitch a ride on
  // copy-pasted Arabic text, especially from PDF / browser sources. ZATCA
  // doesn't care about them; treating two strings that differ only by these
  // as "different" would falsely pass our distinctness check.
  out = out.replace(/[​-‏‪-‮⁦-⁩﻿]/g, '');
  // Strip leading/trailing dashes, dots, and spaces — catalog formatting
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
  /** Default true. Set to false to skip entirely. */
  enabled?: boolean;
  /** Cap on tokens the LLM may emit. Default 300 (the JSON is small). */
  maxTokens?: number;
  /** Override the model. Defaults to env LLM_MODEL_STRONG (Sonnet). */
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

/**
 * Generate a ZATCA-safe submission description for the chosen code.
 * Always returns a result; never throws on LLM failure (degrades to the
 * deterministic fallback so the broker never sees an empty submission
 * field).
 */
export async function generateSubmissionDescription(
  params: GenerateSubmissionParams,
): Promise<SubmissionDescriptionResult> {
  const { effectiveDescription, chosenCode, catalogDescriptionAr, catalogDescriptionEn, opts = {} } = params;
  const { enabled = true, maxTokens = 300 } = opts;

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
