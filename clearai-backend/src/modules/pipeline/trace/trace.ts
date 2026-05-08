/**
 * Trace builder — assembles a PipelineTrace from stage outputs.
 */
import type {
  PipelineTrace,
  TrackAResult,
  TrackBResult,
  StageVerdictOutput,
  SanityResult,
  StageTrace,
} from '../shared/pipeline.types.js';

export function buildTrace(params: {
  trackA: TrackAResult | null;
  trackB: TrackBResult | null;
  verdict: StageVerdictOutput | null;
  sanity: SanityResult | null;
  stages: StageTrace[];
}): PipelineTrace {
  return {
    track_a: params.trackA,
    track_b: params.trackB,
    verdict: params.verdict,
    sanity: params.sanity,
    stages: params.stages,
  };
}
