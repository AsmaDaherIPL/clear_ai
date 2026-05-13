import { runResearcher, runWebResearcher, type ResearcherOutput } from './researcher/researcher.js';
import { runRetrieval } from './retrieval/retrieval.js';
import { runThreshold, DEFAULT_THRESHOLDS } from './threshold/threshold.js';
import { runPicker } from './picker/picker.js';
import {
  computePickerConfidence,
  countTokens,
  pickedHeading,
} from './picker/picker-confidence.js';
import { leafCountUnderHeading } from './picker/leaf-count.js';
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
    attempts: r.attempts,
    ...(r.retried_reasons.length > 0 ? { retried_reasons: r.retried_reasons } : {}),
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
  //
  // identity_tokens (PR2 / Layer 1): cleanup emits up to 4 lexical anchors
  // that don't belong in cleaned_description but carry classification
  // signal — ingredient names ("panthenol"), foreign-language customs
  // nouns ("بانثينول"), brand-as-chapter identifiers ("lego"). Appending
  // them to the retrieval query lets BM25/trigram surface catalog rows
  // that mention them even when the embedder has never seen them. The
  // tokens are deduplicated against cleaned_description in cleanup itself
  // to avoid double-weighting.
  const identityAnchor = (cleanup.identity_tokens ?? []).join(' ');
  let retrieval_query = [
    cleanup.tariff_expansion_en || cleanup.cleaned_description,
    identityAnchor,
  ]
    .filter((s) => s.length > 0)
    .join(' ');
  let interpretation_stage: DescriptionClassifierResult['interpretation_stage'] = 'cleaned';
  let researchDetail: DescriptionClassifierResearchDetail | null = null;
  let webResearchDetail: DescriptionClassifierResearchDetail | null = null;
  // PR3 / Layer 5: family hint carried forward from web research to the
  // main retrieval call. Empty string when no hint is available.
  let pendingFamilyChapter = '';

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
        attempts: research.attempts,
        ...(research.retried_reasons.length > 0
          ? { retried_reasons: research.retried_reasons }
          : {}),
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
          attempts: web.attempts,
          ...(web.retried_reasons.length > 0
            ? { retried_reasons: web.retried_reasons }
            : {}),
        },
      });

      if (web.recognised && web.enriched_description) {
        // Web rescued it. Use the web-derived description for both
        // retrieval and the picker's effective_description, then
        // fall through to the normal retrieval+threshold+picker
        // happy path below.
        effective_description = web.enriched_description;
        retrieval_query = web.enriched_description;
        if (web.family_chapter) {
          pendingFamilyChapter = web.family_chapter;
        }
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
            inferred_chapters: [],
            prefilter_aborted: false,
            picker_confidence: null,
          },
          stages,
        };
      }
    }
  } else {
    interpretation_stage = cleanup.degraded ? 'passthrough' : 'cleaned';
  }

  const t1 = Date.now();
  let retrieval = await runRetrieval(retrieval_query, {
    ...(pendingFamilyChapter ? { family_chapter: pendingFamilyChapter } : {}),
  });
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
      ...(pendingFamilyChapter ? { family_chapter: pendingFamilyChapter } : {}),
      ...(retrieval.family_widened ? { family_widened: true } : {}),
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
        attempts: web.attempts,
        ...(web.retried_reasons.length > 0
          ? { retried_reasons: web.retried_reasons }
          : {}),
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
      // PR3 / Layer 5: when web research emitted a family_chapter hint
      // (2-digit HS chapter), pass it to retrieval. retrieval.ts widens
      // the pool with chapter-scoped candidates only if the
      // unconstrained pass missed that family entirely — cheap on the
      // happy path, rescues row-42-class cases where the embedder
      // landed in a wrong-family neighbourhood.
      retrieval = await runRetrieval(retrieval_query, {
        ...(web.family_chapter ? { family_chapter: web.family_chapter } : {}),
      });
      stages.push({
        name: 'track-a/retrieval-after-web',
        started_at: new Date(tr2).toISOString(),
        duration_ms: retrieval.latency_ms,
        outcome: 'ok',
        detail: {
          candidate_count: retrieval.candidates.length,
          effective_description,
          retrieval_query,
          ...(web.family_chapter ? { family_chapter: web.family_chapter } : {}),
          ...(retrieval.family_widened ? { family_widened: true } : {}),
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
        inferred_chapters: [],
        prefilter_aborted: false,
        picker_confidence: null,
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
      attempts: picker.attempts,
      ...(picker.attempts > 1 ? { retried_reasons: picker.retried_reasons } : {}),
    },
  });

  // Picker confidence: relative score over the annotated candidates,
  // penalised by leaf-space fan-out under the picked heading and by
  // description thinness. Cheap to compute; used by reconciliation to
  // gate CONTRADICTION overrides against thin-description low-confidence
  // pickers (row-135 / TORY 45 class). Null when no positive verdict.
  const heading = pickedHeading(picker.annotated_candidates);
  const leafCount = heading ? await leafCountUnderHeading(heading) : null;
  const picker_confidence = computePickerConfidence({
    candidates: picker.annotated_candidates,
    leafCountInPickedHeading: leafCount,
    effectiveDescriptionTokens: countTokens(effective_description),
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
      inferred_chapters: picker.prefilter?.inferred_chapters ?? [],
      prefilter_aborted: picker.prefilter?.aborted ?? false,
      picker_confidence,
    },
    stages,
  };
}
