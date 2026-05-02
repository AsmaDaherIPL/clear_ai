/**
 * Stage 0 — merchant-input cleanup. Builds a concatenated query (raw + cleaned
 * hint) so retrieval sees both the original lexical signal and the extracted
 * noun + attributes.
 */
import { cleanDescription, type DescriptionCleanupResult } from '../../preprocess/description-cleanup.js';
import { isEnabled, type Thresholds } from '../../catalog/setup-meta.js';
import type { ModelCallTrace } from '../../llm/structured-call.js';
import type { InterpretationStage } from '../interpretation.js';

export interface CleanupStageResult {
  cleanup: DescriptionCleanupResult | null;
  effectiveDescription: string;
  stage: InterpretationStage;
}

export async function runCleanupStage(params: {
  description: string;
  thresholds: Thresholds;
  /** Pushed to iff the LLM was called. */
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

  const cleanup = await cleanDescription(description, {
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

  // 'merchant_shorthand' / 'ungrounded' leave raw untouched; later stages handle them.
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
