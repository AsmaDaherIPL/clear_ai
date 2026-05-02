/** Builds the "interpretation" block surfaced to the user — what cleanup / researcher / chapter-hint did to the input. */
import type { ResearchOutcome } from '../preprocess/research.js';
import type { MerchantCleanupResult } from '../preprocess/description-cleanup.js';
import type { ChapterHintResult } from '../preprocess/chapter-hint.js';
import type { InterpretationStage, MerchantCleanupKind } from '../types/domain.js';
export type { InterpretationStage } from '../types/domain.js';

export interface InterpretationBlock {
  original: string;
  stage: InterpretationStage;
  cleaned_as?: string;
  cleanup_kind?: MerchantCleanupKind;
  cleanup_attributes?: string[];
  cleanup_stripped?: string[];
  /** Single-word typo fixes the cleanup applied (heals→heels, etc.). Populated when non-empty. */
  cleanup_typo_corrections?: { from: string; to: string }[];
  rewritten_as?: string;
  researcher_note?: string;
  /** Chapter-hint output (commit #5 of new-pipeline rollout). Surfaced when invoked. */
  chapter_hint?: {
    likely_chapters: string[];
    confidence: number;
    rationale: string;
  };
}

export interface BuildInterpretationParams {
  description: string;
  stage: InterpretationStage;
  effectiveDescription: string;
  research: ResearchOutcome | null;
  cleanup: MerchantCleanupResult | null;
  chapterHint?: ChapterHintResult | null;
}

export function buildInterpretation(params: BuildInterpretationParams): InterpretationBlock {
  const { description, stage, effectiveDescription, research, cleanup, chapterHint } = params;
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
    if (cleanup.typoCorrections.length > 0) {
      out.cleanup_typo_corrections = cleanup.typoCorrections;
    }
  }

  if (stage === 'researched') out.rewritten_as = effectiveDescription;
  if (stage === 'unknown' && research && research.kind === 'unknown') {
    out.researcher_note = research.reason;
  }

  if (chapterHint && chapterHint.invoked === 'llm') {
    out.chapter_hint = {
      likely_chapters: chapterHint.likelyChapters,
      confidence: chapterHint.confidence,
      rationale: chapterHint.rationale,
    };
  }

  return out;
}
