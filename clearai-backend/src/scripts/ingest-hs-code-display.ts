/**
 * Build hs_code_display rows from the live hs_codes table.
 *
 * Idempotent: TRUNCATEs hs_code_display and re-builds. Safe to run after
 * `pnpm db:seed` (the main ZATCA xlsx ingest).
 *
 * Derivation rules (ADR-0025):
 *   • label_en/ar  = stripDashes(hs_codes.description_en/ar)
 *   • depth        = leading-dash count of description_en
 *                    (0 = heading-padded XXXX00000000 row,
 *                     1–3 = intermediate "- ", "- - ", "- - - " levels,
 *                     4 = product leaf with no dashes)
 *   • path_codes   = walks BACK through hs_codes within the same heading,
 *                    picking the most-recent row at each strictly-smaller
 *                    depth. The HS hierarchy's intermediate levels (e.g.
 *                    640290000000 "- Other footwear :" being the parent
 *                    of 640299000000 "- - Other") are NOT a digit-prefix
 *                    relationship — they share heading 6402 but differ in
 *                    the next digit. Walking by dash-depth within the
 *                    heading is the only correct ancestry inference.
 *                    Always ends with self.
 *   • path_en/ar   = labels of path_codes, joined by " > "
 *   • is_generic_label = label_en in {"Other"} OR label_ar in {"غيرها"}
 *   • is_declarable    = the column replaces is_leaf. In the current
 *                        catalog every 12-digit code is declarable; that
 *                        equivalence is preserved here. We isolate the
 *                        decision into one place so we can later mark
 *                        heading-padded rows as not-declarable when the
 *                        broker UX is ready for that distinction.
 *
 * Note on chapter-level rows: the ZATCA xlsx has NO chapter-only rows
 * (XX0000000000 doesn't exist for any chapter). So path_codes never
 * includes a 2-digit-padded ancestor — only heading (XXXX00000000),
 * hs6 (XXXXXX000000), hs8 (XXXXXXXX0000), and hs10 (XXXXXXXXXX00) when
 * they exist in the catalog.
 */
import { getPool, closeDb } from '../db/client.js';

const BATCH_INSERT = 200;

interface HsRow {
  code: string;
  description_en: string | null;
  description_ar: string | null;
}

function stripDashes(s: string | null | undefined): string {
  if (!s) return '';
  return s.replace(/^[-\s]+/, '').trim();
}

/** Leading-dash count from the EN description. */
function descDepth(en: string | null | undefined): number {
  if (!en) return 0;
  const m = en.match(/^(-\s*)+/);
  if (!m) return 0;
  return (m[0].match(/-/g) ?? []).length;
}

/**
 * Build the heading-padded ancestor (always present) for a 12-digit code.
 * The full intermediate ancestry is computed via a same-heading dash-depth
 * walk in main() — see the rolling-window logic there.
 */
function headingPaddedCode(code: string): string {
  return code.slice(0, 4) + '00000000';
}

const GENERIC_EN = new Set(['other']);
const GENERIC_AR = new Set(['غيرها', 'اخرى', 'أخرى']);

function isGeneric(labelEn: string, labelAr: string): boolean {
  return GENERIC_EN.has(labelEn.toLowerCase().trim()) || GENERIC_AR.has(labelAr.trim());
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const pool = getPool();

  console.log('[ingest-hs-code-display] reading hs_codes (ORDER BY code — matches ZATCA xlsx order) …');
  // Lexical sort on the 12-digit code string equals ZATCA xlsx order, since
  // all codes are zero-left-padded to the same length. This ordering is
  // what makes the same-heading dash-depth walk deterministic.
  const all = await pool.query<HsRow>(
    `SELECT code, description_en, description_ar FROM hs_codes ORDER BY code`,
  );
  console.log(`[ingest-hs-code-display] ${all.rows.length} rows`);

  // Build a quick lookup of code → {labelEn, labelAr} for path label resolution.
  const labelOf = new Map<string, { labelEn: string; labelAr: string }>();
  for (const r of all.rows) {
    labelOf.set(r.code, {
      labelEn: stripDashes(r.description_en),
      labelAr: stripDashes(r.description_ar),
    });
  }

  // Walk the rows in code-sort order, maintaining per-heading
  // "last-seen-at-each-depth" stacks. For each row, its ancestors are
  // the heading-padded row + the most recent rows in the same heading
  // at each strictly-smaller dash depth.
  type DisplayRow = {
    code: string;
    labelEn: string;
    labelAr: string | null;
    pathEn: string;
    pathAr: string | null;
    pathCodes: string[];
    depth: number;
    isGenericLabel: boolean;
    isDeclarable: boolean;
  };

  // Per-heading state: lastAtDepth[heading][depth] = most-recent code at that depth.
  const lastAtDepth = new Map<string, Map<number, string>>();
  const display: DisplayRow[] = [];

  for (const r of all.rows) {
    const labelEn = stripDashes(r.description_en);
    const labelAr = stripDashes(r.description_ar);
    const heading = r.code.slice(0, 4);
    const headingPadded = headingPaddedCode(r.code);

    // Saudi-extension detection: rows whose last 4 digits are NOT zero
    // (e.g. 640219000001 "Soccer shoes …") have no dashes in the
    // description, so descDepth() returns 0 — but conceptually they are
    // CHILDREN of the corresponding XXXXXXXX0000 row (here 640219000000).
    // Treat them as one level deeper than that hs8 parent.
    const last4Zero = r.code.slice(8) === '0000';
    const hs8Parent = r.code.slice(0, 8) + '0000';
    const isExtension = !last4Zero && labelOf.has(hs8Parent) && hs8Parent !== r.code;

    let myDepth: number;
    if (isExtension) {
      // Inherit hs8 parent's depth + 1. We computed it earlier in the loop.
      const parentDisplay = display.find((d) => d.code === hs8Parent);
      myDepth = (parentDisplay?.depth ?? 0) + 1;
    } else {
      myDepth = descDepth(r.description_en);
    }

    // Build path_codes:
    //   1. heading-padded code (if it exists in hs_codes AND isn't self)
    //   2. for each depth d in [1..myDepth-1], the last seen ancestor at d
    //      in this heading (if any, AND isn't self)
    //   3. self (always last)
    // For extension rows, we ALSO ensure the hs8 parent appears (it
    // should already be in the stack since extensions follow their
    // parent in code order).
    const stack = lastAtDepth.get(heading);
    const pathCodes: string[] = [];

    if (labelOf.has(headingPadded) && headingPadded !== r.code) {
      pathCodes.push(headingPadded);
    }
    if (stack) {
      for (let d = 1; d < myDepth; d++) {
        const ancCode = stack.get(d);
        if (ancCode && ancCode !== r.code && !pathCodes.includes(ancCode)) {
          pathCodes.push(ancCode);
        }
      }
    }
    pathCodes.push(r.code);

    // Update last-seen state with self (so subsequent deeper rows can find us).
    if (!lastAtDepth.has(heading)) lastAtDepth.set(heading, new Map());
    lastAtDepth.get(heading)!.set(myDepth, r.code);
    // Clear deeper levels — entering a new branch invalidates stale deeper ancestors.
    for (const [d] of lastAtDepth.get(heading)!) {
      if (d > myDepth) lastAtDepth.get(heading)!.delete(d);
    }

    // Build path_en / path_ar from labels of path_codes.
    const pathEnParts: string[] = [];
    const pathArParts: string[] = [];
    for (const c of pathCodes) {
      const lbl = labelOf.get(c)!;
      if (lbl.labelEn) pathEnParts.push(lbl.labelEn);
      if (lbl.labelAr) pathArParts.push(lbl.labelAr);
    }
    const pathEn = pathEnParts.join(' > ');
    const pathAr = pathArParts.length ? pathArParts.join(' > ') : null;

    display.push({
      code: r.code,
      labelEn: labelEn || r.code, // never let label_en be empty (NOT NULL)
      labelAr: labelAr || null,
      pathEn: pathEn || labelEn || r.code,
      pathAr,
      pathCodes,
      depth: myDepth,
      isGenericLabel: isGeneric(labelEn, labelAr),
      isDeclarable: true, // current rule: every HS12 row is declarable; see ADR-0025 note
    });
  }

  // TRUNCATE + bulk insert.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE TABLE hs_code_display');

    let inserted = 0;
    for (let i = 0; i < display.length; i += BATCH_INSERT) {
      const slice = display.slice(i, i + BATCH_INSERT);
      const placeholders: string[] = [];
      const values: unknown[] = [];
      let p = 1;
      for (const r of slice) {
        const ph = [
          `$${p++}`, `$${p++}`, `$${p++}`, `$${p++}`, `$${p++}`,
          `$${p++}::jsonb`, `$${p++}`, `$${p++}`, `$${p++}`,
        ].join(',');
        placeholders.push(`(${ph})`);
        values.push(
          r.code,
          r.labelEn,
          r.labelAr,
          r.pathEn,
          r.pathAr,
          JSON.stringify(r.pathCodes),
          r.depth,
          r.isGenericLabel,
          r.isDeclarable,
        );
      }
      await client.query(
        `INSERT INTO hs_code_display
           (code, label_en, label_ar, path_en, path_ar, path_codes, depth, is_generic_label, is_declarable)
         VALUES ${placeholders.join(',')}`,
        values,
      );
      inserted += slice.length;
      if (i % (BATCH_INSERT * 20) === 0) {
        console.log(`  ${inserted}/${display.length}`);
      }
    }

    await client.query('COMMIT');
    console.log(`[ingest-hs-code-display] ✓ inserted ${inserted} rows`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[ingest-hs-code-display] failed, rolled back:', err);
    throw err;
  } finally {
    client.release();
  }

  console.log(`[ingest-hs-code-display] total wall time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err);
    await closeDb();
    process.exit(1);
  });
