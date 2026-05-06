/**
 * Phase 2 — declaration service.
 * Runs ONLY when declaration_runs.mode === 'classify_and_declare'.
 *
 *   1. listClassifiedItems(declarationRunId)  — items in {succeeded, flagged}
 *   2. resolve tenant config (bundleSize, hvThresholdSar, constants)
 *   3. partition HV / LV via integrations/zatca/declaration/declaration.bundler
 *   4. per bundle: render via declaration.template, upload to blob, persist row
 *   5. set declaration_runs.declaration_status='completed'
 *
 * NEVER calls dispatch(). NEVER reads canonical via the LLM. The phase only
 * consumes already-classified items.
 */
import { getDeclarationRun } from '../declaration-run.repository.js';
import { runDeclarationPhase } from './declaration.runner.js';

/**
 * Public entrypoint called by the top-level use-case AFTER Phase 1 finishes.
 * No-op when mode='classify_only'; the use-case never reaches this for a
 * classify_only declaration_run but we double-check defensively.
 */
export async function runDeclarationPhaseIfNeeded(declarationRunId: string): Promise<void> {
  const declarationRun = await getDeclarationRun(declarationRunId);
  if (declarationRun.mode !== 'classify_and_declare') return;
  await runDeclarationPhase(declarationRunId);
}
