/**
 * The "interpretation" block surfaces every transformation we did to the
 * user's raw input — what cleanup pulled out, what the researcher
 * rewrote it as, what couldn't be identified. The frontend renders it
 * as an "Understood as: …" line so the user can spot when the system
 * misread the input (the most common failure mode that's invisible
 * without this hint).
 *
 * Lifted out of routes/describe.ts unchanged so it can be reused if
 * other endpoints later want the same trace surface, and so the route
 * file shrinks toward a pure orchestrator.
 */
import type { ResearchOutcome } from '../preprocess/research.js';
import type { MerchantCleanupResult } from '../preprocess/merchant-cleanup.js';

export type InterpretationStage = 'passthrough' | 'cleaned' | 'researched' | 'unknown';

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

  // Surface cleanup outcome whenever the LLM ran (regardless of whether
  // the result was used as the retrieval input). The frontend can show
  // "we ignored: Samsung, Galaxy S25 Ultra, …" so the user can sanity-check.
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
