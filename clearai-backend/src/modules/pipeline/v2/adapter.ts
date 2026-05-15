/**
 * Pipeline rewrite — PR 12: v2 → legacy PipelineResult adapter.
 *
 * The legacy PipelineResult envelope is what `runPipeline` returns to
 * callers (route handlers, batch dispatch, recorders). During PRs 12–13
 * we keep that envelope stable so the only thing v2 changes is what
 * lives INSIDE `trace` — not the shape of the wrapper.
 *
 * After PR 13 deletes legacy + anchored, this adapter goes away and
 * `runPipeline` returns PipelineResultV2 directly.
 *
 * Mapping rules (PR 12 — purely structural, no behavior change):
 *
 *   v2.final_code             →  legacy.final_code
 *   v2.goods_description_ar   →  legacy.goods_description_ar
 *   v2.sanity_verdict         →  legacy.sanity_verdict (PASS when null)
 *   v2.hitl                   →  legacy.hitl
 *   v2.infra_degraded         →  legacy.infra_degraded
 *   v2.trace                  →  legacy.trace.pipeline_v2 (under a new field)
 *
 * Legacy fields under PipelineTrace that v2 doesn't produce (track_a,
 * track_b, verdict, anchored_*) are set to null. The new pipeline_v2
 * field carries the v2 trace verbatim; dispatch-v1.ts reads it via
 * `pipeline_architecture === 'v2'` and renders the corresponding wire
 * shape.
 *
 * stages[] (the flat StageTrace[] the legacy assembler reads) is
 * intentionally left empty under v2 — the v2 trace's stage outputs are
 * structured per-stage objects (identify, scope, pick, etc.) and don't
 * need to be flattened. The dispatch-v1 v2 branch builds actions
 * directly from those structured outputs.
 */
import type {
  PipelineResult,
  PipelineTrace,
  SanityVerdict,
} from '../shared/pipeline.types.js';
import type { PipelineResultV2 } from './types.js';

export function adaptV2ToPipelineResult(v2: PipelineResultV2): PipelineResult {
  const trace: PipelineTrace = {
    // Legacy parallel-tracks fields — null under v2.
    track_a: null,
    track_b: null,
    verdict: null,
    // Anchored fields — null under v2.
    anchored_identify: null,
    anchored_constrain: null,
    anchored_pick: null,
    // Shared.
    sanity: v2.trace.sanity,
    stages: v2.trace.stages,
    // v2 trace carried verbatim. Dispatch-v1 reads this when
    // pipeline_architecture === 'v2'.
    pipeline_v2: v2.trace,
    pipeline_architecture: 'v2',
  };

  // Legacy PipelineResult requires sanity_verdict to be non-null. v2 can
  // return null on escalate paths (sanity never ran). Default to PASS in
  // that case — the actual escalate signal is carried by hitl.reason.
  const sanity_verdict: SanityVerdict = v2.sanity_verdict ?? 'PASS';

  return {
    final_code: v2.final_code,
    goods_description_ar: v2.goods_description_ar,
    sanity_verdict,
    trace,
    hitl: v2.hitl,
    infra_degraded: v2.infra_degraded,
  };
}
