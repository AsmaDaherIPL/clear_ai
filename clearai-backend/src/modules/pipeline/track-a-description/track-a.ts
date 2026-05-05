/**
 * Track A — Description classifier.
 *
 * Receives the cleaned description (from Stage 1). Merchant code is NEVER
 * visible here. Runs: Researcher (conditional) → Retrieval → Threshold → Picker.
 */
import { runResearcher } from './researcher/researcher.js';
import { runRetrieval } from './retrieval/retrieval.js';
import { runThreshold, DEFAULT_THRESHOLDS } from './threshold/threshold.js';
import { runPicker } from './picker/picker.js';
import type { CleanupResult, TrackAResult, StageTrace } from '../shared/pipeline.types.js';

export interface TrackAOptions {
  thresholds?: { minScore: number; minGap: number };
}

export async function runTrackA(
  cleanup: CleanupResult,
  raw_description: string,
  opts: TrackAOptions = {},
): Promise<{ result: TrackAResult; stages: StageTrace[] }> {
  const stages: StageTrace[] = [];
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;

  let effective_description = cleanup.cleaned_description;
  let interpretation_stage: TrackAResult['interpretation_stage'] = 'cleaned';

  // ----- Researcher (conditional) -----
  if (cleanup.clarity_verdict === 'needs_research') {
    const t0 = Date.now();
    const research = await runResearcher(cleanup.cleaned_description, raw_description);
    effective_description = research.enriched_description;
    interpretation_stage = 'researched';
    stages.push({
      name: 'track-a/researcher',
      started_at: new Date(t0).toISOString(),
      duration_ms: research.latency_ms,
      outcome: 'ok',
      detail: { recognised: research.recognised },
    });
  } else {
    interpretation_stage = cleanup.degraded ? 'passthrough' : 'cleaned';
  }

  // ----- Hybrid retrieval -----
  const t1 = Date.now();
  const retrieval = await runRetrieval(effective_description);
  stages.push({
    name: 'track-a/retrieval',
    started_at: new Date(t1).toISOString(),
    duration_ms: retrieval.latency_ms,
    outcome: 'ok',
    detail: { candidate_count: retrieval.candidates.length },
  });

  // ----- Threshold check -----
  const t2 = Date.now();
  const threshold = runThreshold(retrieval.candidates, effective_description, thresholds);
  stages.push({
    name: 'track-a/threshold',
    started_at: new Date(t2).toISOString(),
    duration_ms: Date.now() - t2,
    outcome: 'ok',
    detail: { passed: threshold.passed },
  });

  if (!threshold.passed) {
    return {
      result: {
        chosen_code: null,
        confidence: null,
        rationale: null,
        alternatives: [],
        threshold_failed: true,
        no_fit: false,
        interpretation_stage,
      },
      stages,
    };
  }

  // ----- Picker -----
  const t3 = Date.now();
  const picker = await runPicker(effective_description, retrieval.candidates);
  stages.push({
    name: 'track-a/picker',
    started_at: new Date(t3).toISOString(),
    duration_ms: picker.latency_ms,
    outcome: 'ok',
    detail: { chosen: picker.chosen_code, no_fit: picker.no_fit },
  });

  return {
    result: {
      chosen_code: picker.chosen_code,
      confidence: picker.confidence,
      rationale: picker.rationale,
      alternatives: picker.alternatives,
      threshold_failed: false,
      no_fit: picker.no_fit,
      interpretation_stage,
    },
    stages,
  };
}
