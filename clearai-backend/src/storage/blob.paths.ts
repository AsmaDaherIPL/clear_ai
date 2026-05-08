/**
 * Deterministic blob-key builder. Centralised so every reader/writer
 * agrees on the path layout inside BATCH_BLOB_CONTAINER.
 *
 * Two layouts coexist:
 *
 *   Legacy (input + Phase-1 result, still in use):
 *     declaration-runs/{id}/input.{ext}
 *     declaration-runs/{id}/result.json
 *     declaration-runs/{id}/result.xml
 *     declaration-runs/{id}/declarations/{idx}.xml
 *
 *   New tree layout (per the dev-Azure storage handover, used for the
 *   rendered HV/LV XML output that the SPA downloads):
 *     {operatorSlug}/{YYYY}/{MM}/{DD}/{run_id}/manifest.json
 *     {operatorSlug}/{YYYY}/{MM}/{DD}/{run_id}/hv/{filing_id}.xml
 *     {operatorSlug}/{YYYY}/{MM}/{DD}/{run_id}/lv/{filing_id}.xml
 *
 * The new layout makes the Storage browser tree navigable and lets the
 * lifecycle policy delete entire date partitions.
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

// ---------------------------------------------------------------------------
// New tree layout
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Build the run prefix for the new tree layout. `createdAt` is required so
 * the path is locked in at run-creation time and immune to timezone drift
 * later. `operatorSlug` lives at the top level — when multi-operator
 * lands, queue listings can scope to one operator with a prefix scan.
 */
export function declarationRunPrefix(params: {
  operatorSlug: string;
  createdAt: Date;
  runId: string;
}): string {
  const d = params.createdAt;
  return [
    params.operatorSlug,
    d.getUTCFullYear(),
    pad2(d.getUTCMonth() + 1),
    pad2(d.getUTCDate()),
    params.runId,
  ].join('/');
}

export function manifestKey(prefix: string): string {
  return `${prefix}/manifest.json`;
}

export function hvFilingKey(prefix: string, filingId: string): string {
  return `${prefix}/hv/${filingId}.xml`;
}

export function lvFilingKey(prefix: string, filingId: string): string {
  return `${prefix}/lv/${filingId}.xml`;
}
