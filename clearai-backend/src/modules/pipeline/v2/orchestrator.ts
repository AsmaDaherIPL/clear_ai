/**
 * Pipeline rewrite — orchestrator stub (PR 1).
 *
 * This is the canonical entry point for the rewritten pipeline. PRs 2-11
 * fill in the stage calls. Until then, calling runPipelineV2 throws so
 * any accidental wire-up to live routes fails loudly rather than
 * silently returning a malformed result.
 *
 * Why a stub now: locks the public signature (input/output types) and
 * the import surface (v2/types.ts) before any stage implementation.
 * Every subsequent PR adds a stage and wires it into this orchestrator;
 * no PR needs to re-litigate "where does the new pipeline live."
 *
 * The legacy orchestrator (pipeline.orchestrator.ts) and the anchored
 * orchestrator (anchored-orchestrator.ts) remain untouched. PR 13
 * deletes them and promotes v2/ to the canonical pipeline/ directory.
 */
import type { CanonicalLineItem, PipelineResultV2 } from './types.js';

/**
 * Run the rewritten pipeline end-to-end. Replaces both runLegacyPipeline
 * and runAnchoredPipeline once PR 13 lands.
 *
 * @param item Canonical line item (operator-scoped) to classify.
 * @param operatorSlug Operator identifier (drives per-operator config + overrides).
 * @param itemId The classification_events / declaration_run_items UUID.
 * @returns PipelineResultV2 — the rewritten pipeline's discriminated-union output.
 *
 * @throws `not implemented` Until PR 11 (orchestrator wiring) lands.
 *         Callers must NOT route live traffic here yet.
 */
export async function runPipelineV2(
  _item: CanonicalLineItem,
  _operatorSlug: string,
  _itemId: string,
): Promise<PipelineResultV2> {
  // Sentinel error: visible in logs, traceable to this file, can't be
  // mistaken for a real pipeline failure mode (none of the legacy or
  // anchored escalate reasons match this message).
  throw new Error(
    'runPipelineV2 not implemented: rewrite is mid-flight (PR 1 of 15). ' +
      'Do not route traffic here until PR 11 wires the stages.',
  );
}
