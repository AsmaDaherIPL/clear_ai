/**
 * Trace builder — assembles a PipelineTrace from stage outputs.
 */
import type {
  PipelineTrace,
  DescriptionClassifierResult,
  CodeResolverResult,
  StageVerdictOutput,
  SanityResult,
  StageTrace,
} from '../shared/pipeline.types.js';

export function buildTrace(params: {
  trackA: DescriptionClassifierResult | null;
  trackB: CodeResolverResult | null;
  verdict: StageVerdictOutput | null;
  sanity: SanityResult | null;
  stages: StageTrace[];
  /**
   * Which pipeline implementation produced this trace. Required so
   * shadow-mode validation can SQL-filter classification_events by
   * architecture. See PipelineTrace.pipeline_architecture.
   */
  pipelineArchitecture: 'legacy' | 'anchored';
}): PipelineTrace {
  return {
    track_a: params.trackA,
    track_b: params.trackB,
    verdict: params.verdict,
    sanity: params.sanity,
    stages: params.stages,
    pipeline_architecture: params.pipelineArchitecture,
  };
}
