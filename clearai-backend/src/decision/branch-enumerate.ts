/**
 * Branch-local enumeration — pull every leaf under the chosen code's HS-6
 * subheading from the catalog deterministically.
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
 * Default scope: HS-6 (subheading). At HS-6 the structure is dense enough
 * to be useful (5–15 leaves typically) and narrow enough to avoid huge
 * lists. Tunable via setup_meta.BRANCH_PREFIX_LENGTH for cases where the
 * broker wants HS-4 (broader legal comparison) or HS-8 (tighter commercial
 * comparison).
 *
 * The chosen code itself is INCLUDED in the result so the caller can pin
 * it to the top of the rendered list. The caller decides how to display
 * — this module just enumerates.
 */
import { getPool } from '../db/client.js';

export interface BranchLeaf {
  code: string;
  description_en: string | null;
  description_ar: string | null;
}

export interface EnumerateBranchOpts {
  /** 12-digit chosen code. We derive the prefix from this. */
  chosenCode: string;
  /** Prefix length to enumerate under. One of {4, 6, 8}. Default 6 (HS-6). */
  prefixLength?: 4 | 6 | 8;
  /** Cap on returned leaves to keep response payloads bounded. Default 50. */
  maxLeaves?: number;
}

/**
 * Pull all leaves (is_leaf = true) whose code shares the requested prefix
 * with `chosenCode`. Ordered by code so output is stable across runs and
 * easy to render as a tree-like list.
 *
 * Returns [] (not throws) on:
 *   - non-numeric or short chosenCode
 *   - prefix shorter than chosen code length (defensive — shouldn't happen)
 *   - empty result set (shouldn't happen if chosenCode is itself a leaf)
 *
 * The caller is responsible for handling the empty case (e.g. degraded
 * envelope) — this module never invents leaves.
 */
export async function enumerateBranch(opts: EnumerateBranchOpts): Promise<BranchLeaf[]> {
  const { chosenCode, prefixLength = 6, maxLeaves = 50 } = opts;

  // Defensive: chosenCode must be 12 digits. The schemas enforce this on the
  // wire, but we guard here so the SQL never sees a malformed prefix that
  // would match a wider tree than intended.
  if (!/^\d{12}$/.test(chosenCode)) return [];

  const prefix = chosenCode.slice(0, prefixLength);

  const pool = getPool();
  const r = await pool.query<{
    code: string;
    description_en: string | null;
    description_ar: string | null;
  }>(
    `SELECT code, description_en, description_ar
       FROM hs_codes
      WHERE is_leaf = true
        AND code LIKE $1
      ORDER BY code
      LIMIT $2`,
    [`${prefix}%`, maxLeaves],
  );

  return r.rows;
}
