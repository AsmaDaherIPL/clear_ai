/**
 * Enumerates leaves under the chosen code's HS-prefix deterministically.
 * Widens HS-8 → HS-6 → HS-4 until minSiblings is met. Includes the chosen code.
 */
import { getPool } from '../db/client.js';

export type BranchSource = 'branch_8' | 'branch_6' | 'branch_4';

export interface BranchLeaf {
  code: string;
  description_en: string | null;
  description_ar: string | null;
  source: BranchSource;
}

export interface EnumerateBranchOpts {
  /** 12-digit code; prefix is derived from this. */
  chosenCode: string;
  /** One of {4, 6, 8}. Default 8. */
  prefixLength?: 4 | 6 | 8;
  /** Default 3. */
  minSiblings?: number;
  /** Default 50. */
  maxLeaves?: number;
}

interface Row {
  code: string;
  description_en: string | null;
  description_ar: string | null;
}

async function queryPrefix(prefix: string, limit: number): Promise<Row[]> {
  const pool = getPool();
  // Post-ADR-0008/0029: every hs_codes row is an HS-12 leaf; the old
  // `WHERE is_leaf = true` filter is gone. is_deleted still applies.
  const r = await pool.query<Row>(
    `SELECT code, description_en, description_ar
       FROM hs_codes
      WHERE is_deleted = false
        AND code LIKE $1
      ORDER BY code
      LIMIT $2`,
    [`${prefix}%`, limit],
  );
  return r.rows;
}

const SOURCE_BY_LEN: Record<number, BranchSource> = {
  8: 'branch_8',
  6: 'branch_6',
  4: 'branch_4',
};

/** Returns [] when chosenCode is malformed. Tightest → widest scope, deduplicated. */
export async function enumerateBranch(opts: EnumerateBranchOpts): Promise<BranchLeaf[]> {
  const { chosenCode, prefixLength = 8, minSiblings = 3, maxLeaves = 50 } = opts;

  if (!/^\d{12}$/.test(chosenCode)) return [];

  const widenSequence: Array<4 | 6 | 8> =
    prefixLength === 8 ? [8, 6] : prefixLength === 6 ? [6, 4] : [4];

  const seen = new Set<string>();
  const out: BranchLeaf[] = [];

  for (const len of widenSequence) {
    const prefix = chosenCode.slice(0, len);
    const rows = await queryPrefix(prefix, maxLeaves);
    const source = SOURCE_BY_LEN[len]!;

    for (const r of rows) {
      if (seen.has(r.code)) continue;
      seen.add(r.code);
      out.push({ ...r, source });
      if (out.length >= maxLeaves) break;
    }

    const nonChosen = out.filter((l) => l.code !== chosenCode).length;
    if (nonChosen >= minSiblings || out.length >= maxLeaves) break;
  }

  return out;
}
