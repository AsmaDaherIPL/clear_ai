/**
 * Branch-local enumeration — pull every leaf under the chosen code's
 * HS-prefix from the catalog deterministically, with a layered fallback
 * when the primary scope is too narrow to be useful.
 *
 * Why this exists (Phase 1 of the v3 alternatives redesign):
 *   Today, after the picker accepts a code, the user-facing "alternatives"
 *   list is sourced from the raw RRF retrieval top-K. RRF rescales the long
 *   tail upward once strong matches are exhausted, so users see "Bathing
 *   headgear" or "Horses" listed as alternatives to wireless headphones —
 *   noise the picker correctly ignored, but that the alternatives surface
 *   exposes anyway.
 *
 *   The right shape for the alternatives surface is "what other valid leaves
 *   exist under the same legal family as my chosen code?" That answer is
 *   deterministic SQL, not retrieval. Two requests to /describe with the
 *   same chosen code should produce the same alternatives list, every time.
 *
 * Layered fallback (added in commit 2 of the alternatives-rework):
 *   Some HS-8 branches are sparse — `1509.20.00` (Extra virgin olive oil)
 *   has exactly one leaf in the catalog. Without a fallback, the user sees
 *   only the chosen row, no comparison, no signal that the system thought
 *   about anything. The layered enumerator widens the prefix one level at
 *   a time until it has at least `minSiblings` non-chosen rows OR runs out:
 *
 *     HS-8 (default)   → narrow, commercially-coherent siblings
 *     HS-6 (fallback)  → broader, same-subheading family
 *
 *   We deliberately stop at HS-6 — HS-4 is too broad (a whole heading can
 *   span dozens of unrelated leaves). When even HS-6 is insufficient, the
 *   caller falls back to filtered RRF (with the same MIN_ALT_SCORE floor
 *   that already keeps bathing caps and horses out).
 *
 * Each leaf carries a `source` field so the UI can label which scope it
 * came from ("branch sibling", "same heading", "also retrieved").
 *
 * The chosen code itself is INCLUDED in the result so the caller can pin
 * it to the top of the rendered list. The caller decides how to display
 * — this module just enumerates.
 */
import { getPool } from '../db/client.js';

export type BranchSource = 'branch_8' | 'branch_6' | 'branch_4';

export interface BranchLeaf {
  code: string;
  description_en: string | null;
  description_ar: string | null;
  /**
   * Which scope this leaf came from. Lets the caller render a per-row
   * badge so the user knows whether they're looking at a tight
   * commercial sibling (`branch_8`) or a wider legal comparison
   * (`branch_6` / `branch_4`).
   */
  source: BranchSource;
}

export interface EnumerateBranchOpts {
  /** 12-digit chosen code. We derive the prefix from this. */
  chosenCode: string;
  /**
   * Primary prefix length. One of {4, 6, 8}. Default 8 (HS-8 / national
   * subheading) — testing showed HS-6 mixes structurally-related but
   * commercially-distinct families (e.g. wireless headphones with
   * telephone exchange equipment under 8517.62), while HS-8 keeps
   * comparisons within the same national-leaf family.
   */
  prefixLength?: 4 | 6 | 8;
  /**
   * Minimum non-chosen siblings to surface before widening the prefix.
   * If the primary prefix returns fewer leaves than this, we automatically
   * widen one level at a time. Default 3.
   */
  minSiblings?: number;
  /** Cap on returned leaves (across all source levels). Default 50. */
  maxLeaves?: number;
}

interface Row {
  code: string;
  description_en: string | null;
  description_ar: string | null;
}

async function queryPrefix(prefix: string, limit: number): Promise<Row[]> {
  const pool = getPool();
  const r = await pool.query<Row>(
    `SELECT code, description_en, description_ar
       FROM hs_codes
      WHERE is_leaf = true
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

/**
 * Pull leaves under the chosen code's HS-prefix, widening the scope when
 * the primary scope is too sparse. Returns [] only when the chosen code
 * itself is malformed.
 *
 * Returns leaves in catalog order (numeric code asc) within each scope, with
 * scopes concatenated tightest → widest. The chosen code itself is always
 * the first row from the tightest scope it appears in.
 */
export async function enumerateBranch(opts: EnumerateBranchOpts): Promise<BranchLeaf[]> {
  const { chosenCode, prefixLength = 8, minSiblings = 3, maxLeaves = 50 } = opts;

  // Defensive: chosenCode must be 12 digits.
  if (!/^\d{12}$/.test(chosenCode)) return [];

  // Try the primary prefix first.
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

    // Did we satisfy the minSiblings threshold? Count non-chosen rows in
    // the *current accumulated* set. We continue widening only if we
    // haven't yet hit the threshold AND we haven't hit the leaf cap.
    const nonChosen = out.filter((l) => l.code !== chosenCode).length;
    if (nonChosen >= minSiblings || out.length >= maxLeaves) break;
  }

  return out;
}
