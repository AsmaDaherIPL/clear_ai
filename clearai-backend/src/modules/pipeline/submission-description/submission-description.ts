/**
 * Stage 2.5 — Submission description (lightweight LLM).
 *
 * After Reconciliation has chosen a final 12-digit HS code, ZATCA needs an
 * Arabic goods description for the declaration envelope. The catalog Arabic
 * cannot be copied verbatim — ZATCA rejects declarations whose Arabic text
 * matches the catalog word-for-word — so a lightweight LLM generates a
 * fresh Arabic description for the item.
 *
 * Constraints:
 *   • Arabic only
 *   • ≤300 characters
 *   • Describes the *item* (using cleaned description), not just the code's catalog entry
 *
 * Never throws. Falls back to a deterministic minimal Arabic string on LLM failure.
 */
import { z } from 'zod';
import { structuredLlmCall } from '../../../inference/llm/structured-call.js';
import { env } from '../../../config/env.js';

export interface SubmissionDescriptionResult {
  /** Source of the final descriptionAr — observability only. */
  invoked: 'llm' | 'llm_failed' | 'fallback';
  /** ZATCA-safe Arabic description, ≤300 chars. Always non-empty. */
  descriptionAr: string;
  latencyMs: number;
  model?: string | undefined;
}

const MAX_CHARS = 300;

const ParsedSchema = z
  .object({
    description_ar: z.unknown().optional(),
  })
  .passthrough();

/** Trim, collapse whitespace, enforce length cap. */
function clean(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
}

/** Minimal Arabic fallback. Used only when the LLM fails outright. */
function fallback(catalogDescriptionAr: string | null, cleanedDescription: string): string {
  if (catalogDescriptionAr) {
    return clean(catalogDescriptionAr);
  }
  return clean(`منتج: ${cleanedDescription}`);
}

export interface GenerateSubmissionParams {
  /** The cleaned item description from Stage 1. */
  cleanedDescription: string;
  /** The 12-digit HS code accepted by Stage 2 (Reconciliation). */
  chosenCode: string;
  /** Catalog Arabic description from zatca_hs_codes — only used as a fallback. */
  catalogDescriptionAr: string | null;
  /** Override model. Defaults to lightweight env LLM_MODEL. */
  model?: string;
}

export async function generateSubmissionDescription(
  params: GenerateSubmissionParams,
): Promise<SubmissionDescriptionResult> {
  const { cleanedDescription, chosenCode, catalogDescriptionAr } = params;

  const model = params.model ?? env().LLM_MODEL;

  const user = [
    `Item description: ${cleanedDescription}`,
    `HS code: ${chosenCode}`,
    `Maximum length: ${MAX_CHARS} characters.`,
  ].join('\n');

  const outcome = await structuredLlmCall({
    promptFile: 'submission-description.md',
    user,
    schema: ParsedSchema,
    stage: 'submission_description',
    model,
    maxTokens: 200,
    temperature: 0,
    timeoutMs: 8_000,
  });

  if (outcome.kind !== 'ok') {
    return {
      invoked: 'llm_failed',
      descriptionAr: fallback(catalogDescriptionAr, cleanedDescription),
      latencyMs: outcome.trace.latency_ms,
      model: outcome.trace.model,
    };
  }

  const raw = typeof outcome.data.description_ar === 'string' ? outcome.data.description_ar : '';
  const cleaned = clean(raw);

  if (!cleaned) {
    return {
      invoked: 'fallback',
      descriptionAr: fallback(catalogDescriptionAr, cleanedDescription),
      latencyMs: outcome.trace.latency_ms,
      model: outcome.trace.model,
    };
  }

  return {
    invoked: 'llm',
    descriptionAr: cleaned,
    latencyMs: outcome.trace.latency_ms,
    model: outcome.trace.model,
  };
}
