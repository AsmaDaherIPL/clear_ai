import { runResearcher, runWebResearcher, type ResearcherOutput } from './researcher/researcher.js';
import { runRetrieval } from './retrieval/retrieval.js';
import { runThreshold, DEFAULT_THRESHOLDS } from './threshold/threshold.js';
import { runPicker } from './picker/picker.js';
import type {
  CleanupResult,
  DescriptionClassifierResult,
  DescriptionClassifierResearchDetail,
  StageTrace,
} from '../../shared/pipeline.types.js';

export interface TrackAOptions {
  thresholds?: { minScore: number; minGap: number };
}

function toResearchDetail(r: ResearcherOutput): DescriptionClassifierResearchDetail {
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

export async function runDescriptionClassifier(
  cleanup: CleanupResult,
  raw_description: string,
  opts: TrackAOptions = {},
): Promise<{ result: DescriptionClassifierResult; stages: StageTrace[] }> {
  const stages: StageTrace[] = [];
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;

  let effective_description = cleanup.cleaned_description;
  // Retrieval query is the tariff-vocabulary English expansion when cleanup
  // produced one (non-English input case). The catalog embedder was trained
  // on a general English corpus; querying it in tariff English yields better
  // candidates than querying in the merchant's native language. The
  // picker continues to see the original `effective_description` (not the
  // expansion), so its fit/partial/does_not_fit verdicts and rationales
  // judge candidates against the merchant's actual words.
  let retrieval_query = cleanup.tariff_expansion_en || cleanup.cleaned_description;
  let interpretation_stage: DescriptionClassifierResult['interpretation_stage'] = 'cleaned';
  let researchDetail: DescriptionClassifierResearchDetail | null = null;
  let webResearchDetail: DescriptionClassifierResearchDetail | null = null;

  if (cleanup.clarity_verdict === 'needs_research') {
    const t0 = Date.now();
    const research = await runResearcher(cleanup.cleaned_description, raw_description);
    effective_description = research.enriched_description;
    // Research output supersedes the tariff_expansion_en for the retrieval
    // query — the researcher saw the raw description AND optionally web
    // results, so its enriched output is the strongest available query.
    retrieval_query = research.enriched_description;
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

    // Early web escalation. If the cheap researcher gave up
    // (recognised=false), running retrieval on the unenriched
    // passthrough text is just burning a vector query — it can only
    // pattern-match on noise. Jump straight to web research, then let
    // the rest of the flow continue with web's enriched query (or exit
    // at threshold_failed if web also failed).
    //
    // Pre-2026-05-12 the code did retrieval+threshold first, then
    // escalated to web ONLY if threshold failed — meaning every
    // failed-researcher case paid for one wasted retrieval+threshold
    // pass. This branch skips that.
    if (!research.recognised) {
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

      if (web.recognised && web.enriched_description) {
        // Web rescued it. Use the web-derived description for both
        // retrieval and the picker's effective_description, then
        // fall through to the normal retrieval+threshold+picker
        // happy path below.
        effective_description = web.enriched_description;
        retrieval_query = web.enriched_description;
      } else {
        // Both researcher AND web gave up. Returning early with
        // threshold_failed=true matches the shape Reconciliation
        // already handles for "Track A had nothing useful"; the
        // low-information gate downstream catches it and routes to
        // HITL with reason=low_information.
        return {
          result: {
            annotated_candidates: [],
            threshold_failed: true,
            no_fit: false,
            interpretation_stage,
            effective_description,
            research: researchDetail,
            web_research: webResearchDetail,
          },
          stages,
        };
      }
    }
  } else {
    interpretation_stage = cleanup.degraded ? 'passthrough' : 'cleaned';
  }

  const t1 = Date.now();
  let retrieval = await runRetrieval(retrieval_query);
  stages.push({
    name: 'track-a/retrieval',
    started_at: new Date(t1).toISOString(),
    duration_ms: retrieval.latency_ms,
    outcome: 'ok',
    detail: {
      candidate_count: retrieval.candidates.length,
      effective_description,
      // retrieval_query differs from effective_description only when
      // cleanup emitted a tariff_expansion_en (non-English input case).
      // Surfaced so debugging can verify which query embedded.
      retrieval_query,
    },
  });

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

    if (web.recognised && web.enriched_description) {
      effective_description = web.enriched_description;
      // Web research output supersedes the tariff_expansion_en for retrieval
      // (the web researcher resolved a real product identity, which beats
      // any cleanup-time paraphrase).
      retrieval_query = web.enriched_description;
      interpretation_stage = 'researched';

      const tr2 = Date.now();
      retrieval = await runRetrieval(retrieval_query);
      stages.push({
        name: 'track-a/retrieval-after-web',
        started_at: new Date(tr2).toISOString(),
        duration_ms: retrieval.latency_ms,
        outcome: 'ok',
        detail: {
          candidate_count: retrieval.candidates.length,
          effective_description,
          retrieval_query,
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

  if (!threshold.passed) {
    return {
      result: {
        annotated_candidates: [],
        threshold_failed: true,
        no_fit: false,
        interpretation_stage,
        effective_description,
        research: researchDetail,
        web_research: webResearchDetail,
      },
      stages,
    };
  }

  const t3 = Date.now();
  const picker = await runPicker(effective_description, retrieval.candidates);
  stages.push({
    name: 'track-a/picker',
    started_at: new Date(t3).toISOString(),
    duration_ms: picker.latency_ms,
    outcome: 'ok',
    detail: {
      annotated_count: picker.annotated_candidates.length,
      fits_count: picker.annotated_candidates.filter((a) => a.fit === 'fits').length,
      no_fit: picker.no_fit,
    },
  });

  return {
    result: {
      annotated_candidates: picker.annotated_candidates,
      threshold_failed: false,
      no_fit: picker.no_fit,
      interpretation_stage,
      effective_description,
      research: researchDetail,
      web_research: webResearchDetail,
    },
    stages,
  };
}
