/**
 * Tree layout inside BATCH_BLOB_CONTAINER, shared by every reader/writer:
 *
 *   {operatorSlug}/{YYYY}/{MM}/{DD}/{run_id}/
 *     input.{csv|xlsx}
 *     classifications.json
 *     run-index.json
 *     hv/{filing_id}.xml
 *     lv/{filing_id}.xml
 *
 * The prefix is computed once at run creation (UTC-fixed) and stored on
 * declaration_runs.blob_prefix, so reads never recompute date partitions.
 *
 * Naming note: the run-level index file is called `run-index.json`, not
 * `manifest.json`. "Manifest" in logistics/ZATCA refers specifically to
 * the air-waybill submission that precedes the declaration (see
 * project_zatca_two_step_flow memory rule). Using "manifest" for an
 * internal blob index overloaded the term and made log/audit reading
 * ambiguous. Historical pre-rename batches have `manifest.json` at the
 * same path; the reader path tolerates either name.
 */

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

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

export function classificationsKey(prefix: string): string {
  return `${prefix}/classifications.json`;
}

/**
 * Per-run blob index file. New writes always land at `run-index.json`.
 * Historical (pre-rename) batches have `manifest.json` at the same path —
 * see `legacyRunIndexKey()` for fallback reads.
 */
export function runIndexKey(prefix: string): string {
  return `${prefix}/run-index.json`;
}

/**
 * Legacy filename used by pre-rename batches. Read path falls back to
 * this when `run-index.json` is not present; new writes never use it.
 *
 * @deprecated Remove once all live blob containers have been audited and
 * historical batches are either migrated or deemed unrecoverable.
 */
export function legacyRunIndexKey(prefix: string): string {
  return `${prefix}/manifest.json`;
}

export function filingKey(params: {
  prefix: string;
  strategy: 'HV_STANDALONE' | 'LV_BUNDLED';
  filingId: string;
}): string {
  const sub = params.strategy === 'HV_STANDALONE' ? 'hv' : 'lv';
  return `${params.prefix}/${sub}/${params.filingId}.xml`;
}
