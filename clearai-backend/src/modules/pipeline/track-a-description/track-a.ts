/**
 * Track A — Description classifier.
 *
 * Receives the cleaned description (from Stage 1). Merchant code is NEVER
 * visible here. Runs:
 *   Researcher (conditional, cheap text-only)
 *   → Hybrid retrieval
 *   → Threshold
 *   → if threshold fails AND web wasn't tried yet → Web researcher → re-retrieve
 *   → Picker (when threshold passes)
 *
 * The trace surfaces candidates, research details, and per-stage timing so
 * a caller can see exactly what each substage produced.
 */
import { runResearcher, runWebResearcher, type ResearcherOutput } from './researcher/researcher.js';
import { runRetrieval, type Candidate } from './retrieval/retrieval.js';
import { runThreshold, DEFAULT_THRESHOLDS } from './threshold/threshold.js';
import { runPicker } from './picker/picker.js';
import type {
  CleanupResult,
  TrackAResult,
  TrackACandidate,
  TrackAResearchDetail,
  StageTrace,
} from '../shared/pipeline.types.js';

export interface TrackAOptions {
  thresholds?: { minScore: number; minGap: number };
}

function toResearchDetail(r: ResearcherOutput): TrackAResearchDetail {
  return {
    source: r.source,
    recognised: r.recognised,
    enriched_description: r.enriched_description,
    unrecognised_reason: r.unrecognised_reason,
    evidence_quote: r.evidence_quote,
    model: r.model,
    latency_ms: r.latency_ms,
  };
}

/** Map full retrieval Candidate → trim TrackACandidate (drops internal scores). */
function toTrackACandidates(cs: ReadonlyArray<Candidate>, top = 12): TrackACandidate[] {
  return cs.slice(0, top).map((c) => ({
    code: c.code,
    description_en: c.description_en,
    description_ar: c.description_ar,
    rrf_score: Number(c.rrf_score.toFixed(4)),
  }));
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
  let researchDetail: TrackAResearchDetail | null = null;
  let webResearchDetail: TrackAResearchDetail | null = null;

  // ----- Researcher (conditional) -----
  if (cleanup.clarity_verdict === 'needs_research') {
    const t0 = Date.now();
    const research = await runResearcher(cleanup.cleaned_description, raw_description);
    effective_description = research.enriched_description;
    interpretation_stage = 'researched';
    researchDetail = toResearchDetail(research);
    stages.push({
      name: 'track-a/researcher',
      started_at: new Date(t0).toISOString(),
      duration_ms: research.latency_ms,
      outcome: 'ok',
      detail: {
        source: research.source,
        recognised: research.recognised,
        model: research.model,
        enriched_description: research.enriched_description,
      },
    });
  } else {
    interpretation_stage = cleanup.degraded ? 'passthrough' : 'cleaned';
  }

  // ----- Hybrid retrieval -----
  const t1 = Date.now();
  let retrieval = await runRetrieval(effective_description);
  stages.push({
    name: 'track-a/retrieval',
    started_at: new Date(t1).toISOString(),
    duration_ms: retrieval.latency_ms,
    outcome: 'ok',
    detail: {
      candidate_count: retrieval.candidates.length,
      effective_description,
    },
  });

  // ----- Threshold check -----
  let t2 = Date.now();
  let threshold = runThreshold(retrieval.candidates, effective_description, thresholds);
  stages.push({
    name: 'track-a/threshold',
    started_at: new Date(t2).toISOString(),
    duration_ms: Date.now() - t2,
    outcome: 'ok',
    detail: {
      passed: threshold.passed,
      reason: threshold.passed ? null : (threshold.gate as { reason?: string }).reason ?? null,
    },
  });

  // ----- Web-research escalation (when threshold failed) -----
  // Conditions:
  //   - threshold did NOT pass
  //   - we haven't already used web research this call
  //   - the input genuinely looked like product shorthand (clarity_verdict was
  //     'needs_research' OR retrieval had near-zero matches)
  // Cost: 1 web_search hosted tool call + 1 standard LLM call. Bounded.
  const shouldEscalateToWeb =
    !threshold.passed &&
    !webResearchDetail &&
    (cleanup.clarity_verdict === 'needs_research' || retrieval.candidates.length === 0);

  if (shouldEscalateToWeb) {
    const tw = Date.now();
    const web = await runWebResearcher(raw_description);
    webResearchDetail = toResearchDetail(web);
    stages.push({
      name: 'track-a/web-researcher',
      started_at: new Date(tw).toISOString(),
      duration_ms: web.latency_ms,
      outcome: 'ok',
      detail: {
        source: web.source,
        recognised: web.recognised,
        evidence_quote: web.evidence_quote,
        model: web.model,
        enriched_description: web.enriched_description,
      },
    });

    // Only re-run retrieval if the web researcher recovered something useful.
    if (web.recognised && web.enriched_description) {
      effective_description = web.enriched_description;
      interpretation_stage = 'researched';

      const tr2 = Date.now();
      retrieval = await runRetrieval(effective_description);
      stages.push({
        name: 'track-a/retrieval-after-web',
        started_at: new Date(tr2).toISOString(),
        duration_ms: retrieval.latency_ms,
        outcome: 'ok',
        detail: {
          candidate_count: retrieval.candidates.length,
          effective_description,
        },
      });

      t2 = Date.now();
      threshold = runThreshold(retrieval.candidates, effective_description, thresholds);
      stages.push({
        name: 'track-a/threshold-after-web',
        started_at: new Date(t2).toISOString(),
        duration_ms: Date.now() - t2,
        outcome: 'ok',
        detail: {
          passed: threshold.passed,
          reason: threshold.passed ? null : (threshold.gate as { reason?: string }).reason ?? null,
        },
      });
    }
  }

  const candidates = toTrackACandidates(retrieval.candidates);

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
        effective_description,
        candidates,
        research: researchDetail,
        web_research: webResearchDetail,
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
      effective_description,
      candidates,
      research: researchDetail,
      web_research: webResearchDetail,
    },
    stages,
  };
}
