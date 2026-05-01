/**
 * Loads the set of chapter / heading / hs6 / hs8 / hs10 prefixes from the
 * DB. Cached for the process lifetime.
 */
import { getPool } from '../db/client.js';
import type { KnownPrefixes } from './digit-normalize.js';

let _cache: KnownPrefixes | null = null;

export async function loadKnownPrefixes(): Promise<KnownPrefixes> {
  if (_cache) return _cache;
  const pool = getPool();
  const r = await pool.query<{
    chapter: string;
    heading: string;
    hs6: string;
    hs8: string;
    hs10: string;
  }>(`SELECT DISTINCT chapter, heading, hs6, hs8, hs10 FROM hs_codes`);

  const chapters = new Set<string>();
  const headings = new Set<string>();
  const hs6 = new Set<string>();
  const hs8 = new Set<string>();
  const hs10 = new Set<string>();
  for (const row of r.rows) {
    chapters.add(row.chapter);
    headings.add(row.heading);
    hs6.add(row.hs6);
    hs8.add(row.hs8);
    hs10.add(row.hs10);
  }
  _cache = { chapters, headings, hs6, hs8, hs10 };
  return _cache;
}

export function clearKnownPrefixCache(): void {
  _cache = null;
}
