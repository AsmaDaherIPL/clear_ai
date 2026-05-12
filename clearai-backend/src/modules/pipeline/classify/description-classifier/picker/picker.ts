import { llmClassify } from './llm-pick.js';
import type { Candidate } from '../../../../../inference/retrieval/retrieve.js';
import type { AnnotatedCandidate } from '../../../shared/pipeline.types.js';

export interface PickerOutput {
  annotated_candidates: AnnotatedCandidate[];
  no_fit: boolean;
  latency_ms: number;
}

export async function runPicker(
  effective_description: string,
  candidates: Candidate[],
): Promise<PickerOutput> {
  const start = Date.now();

  const result = await llmClassify({
    kind: 'describe',
    query: effective_description,
    candidates,
  });

  // On LLM failure or parse failure, return empty verdicts so reconciliation
  // treats description_classifier as having no signal (single_b or zero path).
  if (result.llmStatus !== 'ok' || result.parseFailed) {
    return {
      annotated_candidates: [],
      no_fit: true,
      latency_ms: Date.now() - start,
    };
  }

  // Merge verdicts back onto the candidates to preserve rrf_score and descriptions.
  const verdictMap = new Map(result.verdicts.map((v) => [v.code, v]));
  const annotated: AnnotatedCandidate[] = candidates.map((c) => {
    const verdict = verdictMap.get(c.code);
    return {
      code: c.code,
      description_en: c.description_en,
      description_ar: c.description_ar,
      rrf_score: c.rrf_score,
      fit: verdict?.fit ?? 'does_not_fit',
      rationale: verdict?.rationale ?? 'no verdict returned by classifier',
    };
  });

  const no_fit = annotated.every((a) => a.fit === 'does_not_fit');

  return {
    annotated_candidates: annotated,
    no_fit,
    latency_ms: Date.now() - start,
  };
}
