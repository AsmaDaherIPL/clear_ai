/**
 * Tree layout inside BATCH_BLOB_CONTAINER, shared by every reader/writer:
 *
 *   {operatorSlug}/{YYYY}/{MM}/{DD}/{run_id}/
 *     input.{csv|xlsx}
 *     classifications.json
 *     manifest.json
 *     hv/{filing_id}.xml
 *     lv/{filing_id}.xml
 *
 * The prefix is computed once at run creation (UTC-fixed) and stored on
 * declaration_runs.blob_prefix, so reads never recompute date partitions.
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

export function manifestKey(prefix: string): string {
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
