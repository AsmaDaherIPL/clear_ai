/**
 * Anchored pipeline orchestrator. Stub placeholder.
 *
 * PR-A-5 will implement this orchestrator. For now, calling it throws,
 * which is the intended behavior under PR-A-1: the flag-routing
 * scaffolding lands ahead of the actual stage implementations, so any
 * attempt to run the anchored pipeline returns a deterministic
 * "not yet implemented" error.
 *
 * Wiring (to be built in PR-A-5):
 *   parse (deterministic, reused from legacy)
 *     -> identify (PR-A-2, LLM + web, blinded to merchant code)
 *        || (parallel)
 *     -> resolveMerchantCode (PR-A-3, deterministic + small LLM)
 *     -> constrain (PR-A-3, deterministic scope selector)
 *     -> retrieve + pick (PR-A-4, scope-anchored retrieval + picker)
 *     -> submission (reused from legacy, fed identify.identity_tokens)
 *     -> sanity (reused from legacy)
 */
import type { CanonicalLineItem } from '../operators/operator-config.types.js';
import type { PipelineResult } from './shared/pipeline.types.js';

export async function runAnchoredPipeline(
  _item: CanonicalLineItem,
  _operatorSlug: string,
  _itemId: string,
): Promise<PipelineResult> {
  throw new Error(
    'anchored pipeline not yet implemented: orchestrator stub (PR-A-5 will wire identify -> constrain -> pick)',
  );
}
