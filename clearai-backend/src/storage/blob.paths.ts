/**
 * Deterministic blob-key builder. Centralised so every reader/writer agrees
 * on the path layout under BATCH_BLOB_CONTAINER.
 *
 * Layout (all under the configured container):
 *   batches/{batchId}/input.{ext}                 — uploaded source file
 *   batches/{batchId}/result.json                 — Phase 1 results (JSON dump)
 *   batches/{batchId}/result.xml                  — Phase 2 single-XML result
 *   batches/{batchId}/declarations/{idx}.xml      — Phase 2 per-bundle XML
 */

const BATCH_PREFIX = 'batches';

export function inputKey(batchId: string, ext: 'csv' | 'xlsx'): string {
  return `${BATCH_PREFIX}/${batchId}/input.${ext}`;
}

export function classificationsResultKey(batchId: string): string {
  return `${BATCH_PREFIX}/${batchId}/result.json`;
}

export function declarationKey(batchId: string, bundleIndex: number): string {
  if (!Number.isInteger(bundleIndex) || bundleIndex < 0) {
    throw new RangeError(`declarationKey: bundleIndex must be a non-negative integer (got ${bundleIndex})`);
  }
  return `${BATCH_PREFIX}/${batchId}/declarations/${String(bundleIndex).padStart(4, '0')}.xml`;
}
