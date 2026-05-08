/**
 * Deterministic blob-key builder. Every reader/writer agrees on the
 * tree layout inside BATCH_BLOB_CONTAINER:
 *
 *   {operatorSlug}/{YYYY}/{MM}/{DD}/{run_id}/
 *     input.{csv|xlsx}                — uploaded source
 *     classifications.json            — Phase 1 per-item result dump
 *     manifest.json                   — index of every blob in the run
 *     hv/{filing_id}.xml              — HV bundles (rendered XML)
 *     lv/{filing_id}.xml              — LV bundles (rendered XML)
 *
 * The prefix is computed once at run creation time (createdAt is locked
 * in by the DB default + immediately read back) and persisted on
 * declaration_runs.blob_prefix so the read path is timezone-immune.
 *
 * Legacy keys (declaration-runs/{id}/input.{ext}, .../result.json,
 * .../declarations/0000.xml) are dropped — runs created before this
 * migration land remain readable as long as the 90-day lifecycle
 * window keeps them around, then they expire naturally.
 */

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Build the per-run blob prefix. `createdAt` is required so the path
 * is locked in at run-creation time and immune to timezone drift
 * later. `operatorSlug` at the top level so prefix-scanning lists
 * scope to one operator cheaply.
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

export function inputKey(prefix: string, ext: 'csv' | 'xlsx'): string {
  return `${prefix}/input.${ext}`;
}

/** Phase 1 dump of per-item classification results (canonical + final code + trace). */
export function classificationsKey(prefix: string): string {
  return `${prefix}/classifications.json`;
}

export function manifestKey(prefix: string): string {
  return `${prefix}/manifest.json`;
}

/**
 * Build the rendered-XML key for a filing.
 *
 * `strategy` chooses the hv/ or lv/ subfolder. `filingId` is the
 * declaration_run_filings.id (uuid) — guaranteed unique per run so
 * collisions are impossible without a primary-key violation.
 */
export function filingKey(params: {
  prefix: string;
  strategy: 'HV_STANDALONE' | 'LV_BUNDLED';
  filingId: string;
}): string {
  const sub = params.strategy === 'HV_STANDALONE' ? 'hv' : 'lv';
  return `${params.prefix}/${sub}/${params.filingId}.xml`;
}
