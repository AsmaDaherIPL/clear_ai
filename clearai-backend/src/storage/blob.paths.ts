/**
 * Deterministic blob-key builder. Centralised so every reader/writer agrees
 * on the path layout under BATCH_BLOB_CONTAINER.
 *
 * Layout (all under the configured container):
 *   declaration-sets/{id}/input.{ext}              — uploaded source file
 *   declaration-sets/{id}/result.json              — Phase 1 results (JSON dump)
 *   declaration-sets/{id}/result.xml               — Phase 2 single-XML result
 *   declaration-sets/{id}/declarations/{idx}.xml   — Phase 2 per-bundle XML
 */

const DECLARATION_SET_PREFIX = 'declaration-sets';

export function inputKey(declarationSetId: string, ext: 'csv' | 'xlsx'): string {
  return `${DECLARATION_SET_PREFIX}/${declarationSetId}/input.${ext}`;
}

export function classificationsResultKey(declarationSetId: string): string {
  return `${DECLARATION_SET_PREFIX}/${declarationSetId}/result.json`;
}

export function declarationKey(declarationSetId: string, bundleIndex: number): string {
  if (!Number.isInteger(bundleIndex) || bundleIndex < 0) {
    throw new RangeError(`declarationKey: bundleIndex must be a non-negative integer (got ${bundleIndex})`);
  }
  return `${DECLARATION_SET_PREFIX}/${declarationSetId}/declarations/${String(bundleIndex).padStart(4, '0')}.xml`;
}
