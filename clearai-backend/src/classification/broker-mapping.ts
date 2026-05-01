/**
 * Broker-mapping lookup. Resolves a merchant-supplied code to the broker's
 * canonical ZATCA target via exact match, then prefix-walk down to minPrefix.
 */
import { getPool } from '../db/client.js';

export interface BrokerMappingHit {
  targetCode: string;
  targetDescriptionAr: string | null;
  sourceRowRef: string | null;
  /** 12 = exact, < 12 = walked-up. */
  matchedLength: number;
  matchedClientCode: string;
}

export interface BrokerMappingOpts {
  /** Default 6. */
  minPrefix?: number;
}

const DIGITS_ONLY = /[^\d]/g;

/** Returns null when no match at any prefix length, or table empty. */
export async function lookupBrokerMapping(
  rawCode: string,
  opts: BrokerMappingOpts = {},
): Promise<BrokerMappingHit | null> {
  const minPrefix = opts.minPrefix ?? 6;
  const normalised = rawCode.replace(DIGITS_ONLY, '');
  if (normalised.length < minPrefix) return null;

  const pool = getPool();

  // Try literal input then progressively shorter prefixes; longest match wins.
  const candidates: string[] = [];
  for (let len = normalised.length; len >= minPrefix; len--) {
    candidates.push(normalised.slice(0, len));
  }

  const r = await pool.query<{
    client_code_norm: string;
    target_code: string;
    target_description_ar: string | null;
    source_row_ref: string | null;
  }>(
    `SELECT client_code_norm, target_code, target_description_ar, source_row_ref
       FROM broker_code_mapping
      WHERE client_code_norm = ANY($1::varchar[])
      ORDER BY length(client_code_norm) DESC
      LIMIT 1`,
    [candidates],
  );

  const row = r.rows[0];
  if (!row) return null;
  return {
    targetCode: row.target_code,
    targetDescriptionAr: row.target_description_ar,
    sourceRowRef: row.source_row_ref,
    matchedLength: row.client_code_norm.length,
    matchedClientCode: row.client_code_norm,
  };
}
