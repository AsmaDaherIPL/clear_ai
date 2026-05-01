/** Builds the "interpretation" block surfaced to the user — what cleanup / researcher did to the input. */
import type { ResearchOutcome } from '../preprocess/research.js';
import type { MerchantCleanupResult } from '../preprocess/merchant-cleanup.js';
import type { InterpretationStage } from '../types/domain.js';
export type { InterpretationStage } from '../types/domain.js';

export interface InterpretationBlock {
  original: string;
  stage: InterpretationStage;
  cleaned_as?: string;
  cleanup_kind?: 'product' | 'merchant_shorthand' | 'ungrounded';
  cleanup_attributes?: string[];
  cleanup_stripped?: string[];
  rewritten_as?: string;
  researcher_note?: string;
}

export interface BuildInterpretationParams {
  description: string;
  stage: InterpretationStage;
  effectiveDescription: string;
  research: ResearchOutcome | null;
  cleanup: MerchantCleanupResult | null;
}

export function buildInterpretation(params: BuildInterpretationParams): InterpretationBlock {
  const { description, stage, effectiveDescription, research, cleanup } = params;
  const out: InterpretationBlock = {
    original: description,
    stage,
  };

  if (cleanup && cleanup.invoked === 'llm') {
    if (cleanup.kind === 'product' && cleanup.effective !== description) {
      out.cleaned_as = cleanup.effective;
    }
    out.cleanup_kind = cleanup.kind;
    if (cleanup.attributes.length > 0) out.cleanup_attributes = cleanup.attributes;
    if (cleanup.stripped.length > 0) out.cleanup_stripped = cleanup.stripped;
  }

  if (stage === 'researched') out.rewritten_as = effectiveDescription;
  if (stage === 'unknown' && research && research.kind === 'unknown') {
    out.researcher_note = research.reason;
  }
  return out;
}
