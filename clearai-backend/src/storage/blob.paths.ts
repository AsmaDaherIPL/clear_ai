/**
 * Deterministic blob-key builder. Centralised so every reader/writer agrees
 * on the path layout under BATCH_BLOB_CONTAINER.
 *
 * Layout (all under the configured container):
 *   declaration-runs/{id}/input.{ext}              — uploaded source file
 *   declaration-runs/{id}/result.json              — Phase 1 results (JSON dump)
 *   declaration-runs/{id}/result.xml               — Phase 2 single-XML result
 *   declaration-runs/{id}/declarations/{idx}.xml   — Phase 2 per-bundle XML
 */

const DECLARATION_RUN_PREFIX = 'declaration-runs';

export function inputKey(declarationRunId: string, ext: 'csv' | 'xlsx'): string {
  return `${DECLARATION_RUN_PREFIX}/${declarationRunId}/input.${ext}`;
}

export function classificationsResultKey(declarationRunId: string): string {
  return `${DECLARATION_RUN_PREFIX}/${declarationRunId}/result.json`;
}

export function declarationKey(declarationRunId: string, bundleIndex: number): string {
  if (!Number.isInteger(bundleIndex) || bundleIndex < 0) {
    throw new RangeError(`declarationKey: bundleIndex must be a non-negative integer (got ${bundleIndex})`);
  }
  return `${DECLARATION_RUN_PREFIX}/${declarationRunId}/declarations/${String(bundleIndex).padStart(4, '0')}.xml`;
}
