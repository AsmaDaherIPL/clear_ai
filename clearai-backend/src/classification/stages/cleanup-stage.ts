/**
 * Stage 0 — merchant-input cleanup (Phase 1.5, ADR-0012).
 *
 * Strips brand/SKU/marketing noise from raw merchant strings BEFORE
 * retrieval. Deterministically skipped on inputs that already look
 * clean (≤4 tokens, no SKU pattern, no marketing punctuation) inside
 * cleanMerchantInput's `looksClean()` short-circuit — saves an LLM
 * call on the ~80% of merchant descriptions that are already 1–3 word
 * stubs. On noisy inputs, fires Haiku to extract a clean product noun
 * and customs-relevant attributes.
 *
 * V3 (ADR-0020) non-destructive cleanup. Previously the cleaned noun +
 * attributes REPLACED the retrieval query. That stripped useful signal:
 * for "Loewe Puzzle bag" → effective = "bag" lost "Puzzle" (a strong
 * lexical anchor for handbag-family content even if Sonnet's
 * pre-training doesn't know the model). Now we build a CONCATENATED
 * query that keeps the raw input AND adds the cleaned noun + attributes
 * as an explicit hint suffix. The retrieval index sees both signals and
 * weights its own way; we don't pre-decide which is more important.
 *
 * Extracted from routes/describe.ts as part of H2 — keeps the route a
 * pure orchestrator while the per-stage detail lives next to its peer
 * stages under classification/stages/.
 */
import { cleanMerchantInput, type MerchantCleanupResult } from '../../preprocess/merchant-cleanup.js';
import { isEnabled, type Thresholds } from '../../catalog/setup-meta.js';
import type { ModelCallTrace } from '../../llm/structured-call.js';
import type { InterpretationStage } from '../interpretation.js';

export interface CleanupStageResult {
  cleanup: MerchantCleanupResult | null;
  effectiveDescription: string;
  stage: InterpretationStage;
}

export async function runCleanupStage(params: {
  description: string;
  thresholds: Thresholds;
  /** Aggregator from the route — pushes a trace iff cleanup actually called the LLM. */
  modelCalls: ModelCallTrace[];
}): Promise<CleanupStageResult> {
  const { description, thresholds: t, modelCalls } = params;

  if (!isEnabled(t, 'MERCHANT_CLEANUP_ENABLED')) {
    return {
      cleanup: null,
      effectiveDescription: description,
      stage: 'passthrough',
    };
  }

  const cleanup = await cleanMerchantInput(description, {
    maxTokens: t.MERCHANT_CLEANUP_MAX_TOKENS,
  });

  if (cleanup.invoked === 'llm' && cleanup.model) {
    modelCalls.push({
      model: cleanup.model,
      latency_ms: cleanup.latencyMs,
      stage: 'cleanup',
      status: 'ok',
    });
  }

  // For kind === 'merchant_shorthand' or 'ungrounded' we leave the raw
  // input untouched. Stage 2 will route shorthand to the researcher;
  // ungrounded falls through to the gate which will refuse it.
  if (cleanup.invoked === 'llm' && cleanup.kind === 'product') {
    const attrPart = cleanup.attributes.length > 0 ? ` ${cleanup.attributes.join(' ')}` : '';
    const cleanedHint = `${cleanup.effective}${attrPart}`.trim();
    return {
      cleanup,
      effectiveDescription: `${description.trim()} ${cleanedHint}`.trim(),
      stage: 'cleaned',
    };
  }

  return {
    cleanup,
    effectiveDescription: description,
    stage: 'passthrough',
  };
}
