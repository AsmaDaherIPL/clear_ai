/**
 * ZATCA Declaration document-reference id generator.
 *
 * Format observed in Naqel's post-processed samples (NQD26033110789,
 * NQD26030942060, ...):
 *
 *   <prefix><11-digit-suffix>
 *
 * where:
 *   • prefix: tenant-specific (Naqel = "NQD"; future tenants will differ).
 *   • suffix: 11-digit identifier. Naqel's own values look date-prefixed
 *     (`26033110789` ≈ 2026-03-31 + 10789), but per the user's direction
 *     v0 emits a random 11-digit number. Naqel's per-day counter is held
 *     on their side; if they accept our id verbatim we're done, otherwise
 *     a v1 switch to a SEQUENCE-table-backed counter is one PR away.
 *
 * The prefix lives in tenant_constants under key `doc_ref_prefix`. Default
 * 'NQD' if missing.
 */
import { randomInt } from 'node:crypto';

const DEFAULT_PREFIX = 'NQD';

export interface DocIdInput {
  /** Tenant prefix from tenant_constants.doc_ref_prefix; falls back to 'NQD'. */
  prefix?: string;
  /**
   * Override the suffix entirely. Test seam — production calls leave it
   * undefined and the helper generates 11 random digits. Sample-equivalence
   * tests pass the reference XMLs' suffixes (e.g. '26033110789') so the
   * rendered XML matches byte-for-byte.
   */
  suffixOverride?: string;
}

export function buildDocRefNo(input: DocIdInput = {}): string {
  const prefix = (input.prefix && input.prefix.trim()) || DEFAULT_PREFIX;
  if (input.suffixOverride !== undefined) return `${prefix}${input.suffixOverride}`;
  // 11 random digits. Two randomInt calls because randomInt's range is
  // bounded; concat covers the full 11-digit space. Leading zeros allowed.
  const left = String(randomInt(0, 100000)).padStart(5, '0');
  const right = String(randomInt(0, 1000000)).padStart(6, '0');
  return `${prefix}${left}${right}`;
}
