/**
 * Stage 3 — Sanity check (standard LLM, Sonnet-tier, always runs).
 *
 * Checks that the final code accepted by Stage 2 is plausible for the
 * cleaned description. Optionally checks value/currency plausibility.
 *
 * Returns PASS | FLAG | BLOCK. Never throws — degrades to FLAG on failure.
 */
import { z } from 'zod';
import { structuredLlmCall } from '../../../inference/llm/structured-call.js';
import { env } from '../../../config/env.js';
import type { SanityResult, SanityVerdict } from '../shared/pipeline.types.js';

const SanitySchema = z
  .object({
    verdict: z.enum(['PASS', 'FLAG', 'BLOCK']).optional(),
    rationale: z.unknown().optional(),
  })
  .passthrough();

export async function runSanity(params: {
  final_code: string;
  cleaned_description: string;
  value_amount: number | null;
  currency_code: string | null;
}): Promise<SanityResult> {
  const start = Date.now();
  const model = env().LLM_MODEL_STRONG;

  const user = JSON.stringify({
    final_code: params.final_code,
    cleaned_description: params.cleaned_description,
    value_amount: params.value_amount,
    currency_code: params.currency_code,
  });

  const outcome = await structuredLlmCall({
    promptFile: 'sanity.md',
    user,
    schema: SanitySchema,
    stage: 'sanity',
    model,
    maxTokens: 256,
    timeoutMs: 12_000,
  });

  const latency_ms = Date.now() - start;

  if (outcome.kind !== 'ok') {
    // Degrade to FLAG — don't block items on an LLM infrastructure failure,
    // but don't silently pass them either. HITL will review.
    return { verdict: 'FLAG', rationale: `sanity LLM failed: ${outcome.kind}`, latency_ms };
  }

  const d = outcome.data;
  const verdict: SanityVerdict =
    d.verdict === 'PASS' || d.verdict === 'BLOCK' ? d.verdict : 'FLAG';
  const rationale = typeof d.rationale === 'string' ? d.rationale : '';

  return { verdict, rationale, latency_ms };
}
