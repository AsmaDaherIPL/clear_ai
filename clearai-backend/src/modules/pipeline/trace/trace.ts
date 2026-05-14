/**
 * Trace builder — assembles a PipelineTrace from stage outputs.
 *
 * Supports both architectures during the migration window:
 *  - legacy: pass trackA, trackB, verdict, sanity; leave the anchored
 *    fields undefined (they default to null).
 *  - anchored: pass anchoredIdentify, anchoredConstrain, anchoredPick,
 *    sanity; leave the legacy fields undefined.
 *
 * `pipelineArchitecture` is required so consumers can discriminate
 * which family of fields carries real data.
 */
import type {
  PipelineTrace,
  DescriptionClassifierResult,
  CodeResolverResult,
  StageVerdictOutput,
  SanityResult,
  StageTrace,
  IdentifyResult,
  ConstrainResult,
  PickResult,
} from '../shared/pipeline.types.js';

export function buildTrace(params: {
  trackA?: DescriptionClassifierResult | null;
  trackB?: CodeResolverResult | null;
  verdict?: StageVerdictOutput | null;
  sanity: SanityResult | null;
  stages: StageTrace[];
  anchoredIdentify?: IdentifyResult | null;
  anchoredConstrain?: ConstrainResult | null;
  anchoredPick?: PickResult | null;
  /**
   * Which pipeline implementation produced this trace. Required so
   * shadow-mode validation can SQL-filter classification_events by
   * architecture. See PipelineTrace.pipeline_architecture.
   */
  pipelineArchitecture: 'legacy' | 'anchored';
}): PipelineTrace {
  // Exclusivity assertion: legacy and anchored stage outputs must not
  // co-exist on the same trace. Catches an orchestrator bug where one
  // pipeline accidentally passes the other's outputs. Mismatched
  // shapes corrupt downstream consumers (audit recorder, HITL queue,
  // shadow-mode diff tooling).
  const hasLegacyOutputs =
    (params.trackA ?? null) !== null ||
    (params.trackB ?? null) !== null ||
    (params.verdict ?? null) !== null;
  const hasAnchoredOutputs =
    (params.anchoredIdentify ?? null) !== null ||
    (params.anchoredConstrain ?? null) !== null ||
    (params.anchoredPick ?? null) !== null;

  if (params.pipelineArchitecture === 'legacy' && hasAnchoredOutputs) {
    throw new Error(
      'buildTrace invariant: pipelineArchitecture=legacy must not carry anchored stage outputs',
    );
  }
  if (params.pipelineArchitecture === 'anchored' && hasLegacyOutputs) {
    throw new Error(
      'buildTrace invariant: pipelineArchitecture=anchored must not carry legacy stage outputs (trackA/trackB/verdict)',
    );
  }

  return {
    track_a: params.trackA ?? null,
    track_b: params.trackB ?? null,
    verdict: params.verdict ?? null,
    sanity: params.sanity,
    stages: params.stages,
    anchored_identify: params.anchoredIdentify ?? null,
    anchored_constrain: params.anchoredConstrain ?? null,
    anchored_pick: params.anchoredPick ?? null,
    pipeline_architecture: params.pipelineArchitecture,
  };
}
