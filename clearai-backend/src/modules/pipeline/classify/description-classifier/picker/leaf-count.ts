/**
 * Leaf-count lookup for the picker confidence fan-out penalty.
 *
 * Returns the number of active 12-digit leaves under a given 4-digit heading.
 * In-memory cached because the same headings recur across batch items — a
 * batch of 70 rows will typically hit ~20 distinct headings, and hammering
 * the DB for each row would be wasteful.
 *
 * Cache is process-local and never invalidated within a process lifetime.
 * The HS taxonomy is effectively static across a deploy; the cache rebuilds
 * on container restart. That is the right cache lifetime.
 */

import { getPool } from '../../../../../db/client.js';

const cache = new Map<string, number>();

/**
 * Count active 12-digit leaves whose code starts with the given 4-digit
 * heading. Returns 0 if no leaves exist (treated as "unknown" by callers).
 */
export async function leafCountUnderHeading(heading4: string): Promise<number> {
  if (!/^\d{4}$/.test(heading4)) return 0;

  const cached = cache.get(heading4);
  if (cached !== undefined) return cached;

  const pool = getPool();
  const r = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM zatca_hs_codes
      WHERE code LIKE $1
        AND length(code) = 12
        AND is_deleted = false`,
    [`${heading4}%`],
  );
  const n = Number(r.rows[0]?.n ?? 0);
  cache.set(heading4, n);
  return n;
}

/** Test-only. Clears the in-memory cache. */
export function __clearLeafCountCacheForTests(): void {
  cache.clear();
}
