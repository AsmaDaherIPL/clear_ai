/**
 * ZATCA-safe submission description. ZATCA rejects declarations whose Arabic
 * matches the catalog word-for-word; this generates a variant differing by
 * ≥1 token. Two-attempt LLM loop, then deterministic prefix-mutator fallback.
 */
import { z } from 'zod';
import { structuredLlmCall } from '../llm/structured-call.js';
import { env } from '../config/env.js';

export interface SubmissionDescriptionResult {
  invoked: 'disabled' | 'llm' | 'llm_failed' | 'guard_fallback';
  /** Non-empty when invoked != 'disabled'. */
  descriptionAr: string;
  descriptionEn: string;
  /** Total across retries. */
  latencyMs: number;
  model?: string | undefined;
}

const ParsedSubmissionSchema = z
  .object({
    description_ar: z.unknown().optional(),
    description_en: z.unknown().optional(),
  })
  .passthrough();

/** NFKC + strip diacritics + bidi marks + tree punctuation + collapse whitespace. */
function normalizeAr(s: string): string {
  if (!s) return '';
  let out = s.normalize('NFKC');
  out = out.replace(/[ً-ْٰ]/g, '');
  out = out.replace(/[​-‏‪-‮⁦-⁩﻿]/g, '');
  out = out.replace(/^[\s\-·.•]+|[\s\-·.•]+$/g, '');
  out = out.replace(/\s+/g, ' ').trim();
  return out;
}

/** Returns true if the LLM's AR output is acceptably distinct from the catalog AR. */
function passesDistinctnessCheck(generatedAr: string, catalogAr: string | null): boolean {
  if (!catalogAr) return true;
  const a = normalizeAr(generatedAr);
  const b = normalizeAr(catalogAr);
  if (!a) return false;
  return a !== b;
}

/** Last-resort: prepend a customs-relevant word from the description. */
function buildFallback(effectiveDescription: string, catalogAr: string | null): {
  descriptionAr: string;
  descriptionEn: string;
} {
  const STOP = new Set(['a', 'an', 'the', 'of', 'for', 'with', 'and', 'or']);
  const tokens = effectiveDescription
    .split(/[\s,;]+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= 3 && !STOP.has(t));
  const prefix = tokens[0] ?? 'general';

  /** Common product-class prefixes; unmapped tokens ship as latin. */
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
    latencyMs: 0,
  };
}

/** Never throws — falls back to prefix mutator on LLM failure. */
export async function generateSubmissionDescription(
  params: GenerateSubmissionParams,
): Promise<SubmissionDescriptionResult> {
  const { effectiveDescription, chosenCode, catalogDescriptionAr, catalogDescriptionEn, opts = {} } = params;
  const { enabled = true, maxTokens = 120 } = opts;

  if (!enabled) return disabled();

  const e = env();
  const model = opts.model ?? e.LLM_MODEL;

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

    if (outcome.kind !== 'ok') continue;
    const parsed = outcome.data;

    const descAr = typeof parsed.description_ar === 'string' ? parsed.description_ar.trim() : '';
    const descEn = typeof parsed.description_en === 'string' ? parsed.description_en.trim() : '';

    if (!descAr || !descEn) continue;

    if (passesDistinctnessCheck(descAr, catalogDescriptionAr)) {
      return {
        invoked: 'llm',
        descriptionAr: descAr,
        descriptionEn: descEn,
        latencyMs: totalLatency,
        model: lastModel,
      };
    }
  }

  const fb = buildFallback(effectiveDescription, catalogDescriptionAr);
  return {
    invoked: 'guard_fallback',
    descriptionAr: fb.descriptionAr,
    descriptionEn: fb.descriptionEn,
    latencyMs: totalLatency,
    model: lastModel,
  };
}

// Exported for unit testing.
export const __test__ = { normalizeAr, passesDistinctnessCheck, buildFallback };
