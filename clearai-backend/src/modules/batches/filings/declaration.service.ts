/**
 * Phase 2 — declaration service.
 * Runs ONLY when batches.mode === 'classify_and_declare'.
 *
 *   1. listClassifiedItems(batchId)  — items in {succeeded, flagged}
 *   2. resolve operator config (bundleSize, hvThresholdSar, constants)
 *   3. partition HV / LV via integrations/zatca/declaration/declaration.bundler
 *   4. per bundle: render via declaration.template, upload to blob, persist row
 *   5. set batches.declaration_status='completed'
 *
 * NEVER calls dispatch(). NEVER reads canonical via the LLM. The phase only
 * consumes already-classified items.
 */
import { getBatch } from '../batch.repository.js';
import { runDeclarationPhase } from './declaration.runner.js';

/**
 * Public entrypoint called by the top-level use-case AFTER Phase 1 finishes.
 * No-op when mode='classify_only'; the use-case never reaches this for a
 * classify_only batch but we double-check defensively.
 */
export async function runDeclarationPhaseIfNeeded(batchId: string): Promise<void> {
  const batch = await getBatch(batchId);
  if (batch.mode !== 'classify_and_declare') return;
  await runDeclarationPhase(batchId);
}
