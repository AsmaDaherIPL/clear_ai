/**
 * ZATCA Declaration document-reference id generator.
 *
 * Format observed in Naqel's post-processed samples (NQD26033110789,
 * NQD26033110790):
 *
 *   <prefix><YYMMDD><sequence>
 *
 * where:
 *   • prefix: tenant-specific (Naqel = "NQD"; future tenants will differ)
 *   • YYMMDD: 6-digit date (year mod 100, month, day)
 *   • sequence: 5-digit zero-padded incremental number, monotonic per
 *               (tenant, calendar day)
 *
 * Without a Naqel spec for the exact sequence semantics (their two samples
 * use 10789 / 10790, suggesting a global per-day counter we don't have),
 * we derive the sequence deterministically from the declaration_set_id +
 * bundle_index. Pros: no DB hit, no contention. Cons: doesn't match Naqel's
 * own counter — flagged as a v0 deviation; v1 will switch to a SEQUENCE
 * table or the actual Naqel-supplied counter once spec is confirmed.
 *
 * The prefix lives in tenant_constants under key `doc_ref_prefix`. Default
 * 'NQD' for backward compatibility if missing.
 */

const DEFAULT_PREFIX = 'NQD';

export interface DocIdInput {
  /** Submission date (UTC). Naqel's samples use the carrier's local day. */
  date: Date;
  /** Tenant prefix from tenant_constants.doc_ref_prefix; falls back to 'NQD'. */
  prefix?: string;
  /** Parent declaration_set uuid. */
  declarationSetId: string;
  /** 0-based ordinal within the set's render order. */
  bundleIndex: number;
}

export function buildDocRefNo(input: DocIdInput): string {
  const prefix = (input.prefix && input.prefix.trim()) || DEFAULT_PREFIX;
  const yy = String(input.date.getUTCFullYear() % 100).padStart(2, '0');
  const mm = String(input.date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(input.date.getUTCDate()).padStart(2, '0');

  // Derive a 5-digit sequence from the declaration_set_id + bundle_index.
  // Take the trailing 8 hex chars of the uuid (UUIDv7 has timestamp bits in
  // the leading half; trailing chars are random — good for sequence
  // distribution), parse as int, mix in bundleIndex, modulo 99999, +1 to
  // avoid 00000.
  const tail = input.declarationSetId.replace(/-/g, '').slice(-8);
  const tailInt = Number.parseInt(tail, 16);
  const mixed = (Number.isFinite(tailInt) ? tailInt : 0) + input.bundleIndex;
  const seq = String((mixed % 99999) + 1).padStart(5, '0');

  return `${prefix}${yy}${mm}${dd}${seq}`;
}
