import { llmClassify } from './llm-pick.js';
import { filterByChapterCoherence } from './chapter-coherence-filter.js';
import type { Candidate } from '../../../../../inference/retrieval/retrieve.js';
import type { AnnotatedCandidate } from '../../../shared/pipeline.types.js';

export interface PickerOutput {
  annotated_candidates: AnnotatedCandidate[];
  no_fit: boolean;
  latency_ms: number;
  /** Total picker LLM attempts (>=1). */
  attempts: number;
  /** Per-retry reasons recorded by the policy-driven retry loop. */
  retried_reasons: string[];
  /**
   * Forensic detail: which candidates the deterministic chapter-coherence
   * filter dropped before the LLM ran, and which chapters were inferred
   * from the description. Empty when the filter was a no-op (no keywords
   * matched) or aborted (would have dropped below the safety floor).
   */
  prefilter?: {
    inferred_chapters: string[];
    dropped_codes: string[];
    aborted: boolean;
  };
}

export async function runPicker(
  effective_description: string,
  candidates: Candidate[],
): Promise<PickerOutput> {
  const start = Date.now();

  const { filtered, matchedChapters, aborted } = filterByChapterCoherence(
    candidates,
    effective_description,
  );
  const droppedCodes = candidates
    .filter((c) => !filtered.some((f) => f.code === c.code))
    .map((c) => c.code);
  const prefilter = {
    inferred_chapters: matchedChapters,
    dropped_codes: droppedCodes,
    aborted,
  };

  const result = await llmClassify({
    kind: 'describe',
    query: effective_description,
    candidates: filtered,
    stage: 'picker',
  });

  if (result.llmStatus !== 'ok' || result.parseFailed) {
    return {
      annotated_candidates: [],
      no_fit: true,
      latency_ms: Date.now() - start,
      attempts: result.attempts,
      retried_reasons: result.retriedReasons,
      prefilter,
    };
  }

  // Candidates dropped by the chapter-coherence filter are re-surfaced as
  // deterministic does_not_fit so reconciliation and trace readers still
  // see the full retrieval set.
  const verdictMap = new Map(result.verdicts.map((v) => [v.code, v]));
  const annotated: AnnotatedCandidate[] = candidates.map((c) => {
    const verdict = verdictMap.get(c.code);
    if (verdict) {
      return {
        code: c.code,
        description_en: c.description_en,
        description_ar: c.description_ar,
        rrf_score: c.rrf_score,
        fit: verdict.fit,
        rationale: verdict.rationale,
      };
    }
    const dropped = droppedCodes.includes(c.code);
    return {
      code: c.code,
      description_en: c.description_en,
      description_ar: c.description_ar,
      rrf_score: c.rrf_score,
      fit: 'does_not_fit',
      rationale: dropped
        ? `chapter ${c.code.slice(0, 2)} incompatible with inferred chapters [${matchedChapters.join(', ')}]`
        : 'no verdict returned by classifier',
    };
  });

  const no_fit = annotated.every((a) => a.fit === 'does_not_fit');

  return {
    annotated_candidates: annotated,
    no_fit,
    latency_ms: Date.now() - start,
    attempts: result.attempts,
    retried_reasons: result.retriedReasons,
    prefilter,
  };
}
