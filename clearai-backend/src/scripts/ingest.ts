/**
 * Ingest Zatca Tariff codes.xlsx into hs_codes. Drops 4-digit heading rows
 * (leaves only). Generates e5-small embeddings over EN || AR concatenation.
 */
import * as XLSX from 'xlsx';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { getPool, closeDb } from '../db/client.js';
import { embedPassageBatch } from '../embeddings/embedder.js';

// XLSX_PATH resolution order (first match wins):
//   1. ZATCA_XLSX env override — set this in .env.local for CI or custom paths
//   2. naqel-shared-data/ sibling of the repo root (local dev convention)
//   3. Legacy clearai-backend-python/data/ path (kept for backward compat)
async function resolveXlsxPath(): Promise<string> {
  if (process.env['ZATCA_XLSX']) return process.env['ZATCA_XLSX'];
  const candidates = [
    join(process.cwd(), '..', 'naqel-shared-data', 'Zatca Tariff codes.xlsx'),
    join(process.cwd(), '..', 'clearai-backend-python', 'data', 'Zatca Tariff codes.xlsx'),
  ];
  for (const p of candidates) {
    try { await access(p); return p; } catch { /* try next */ }
  }
  // Fall through to first candidate — will fail at readFile with a clear ENOENT.
  return candidates[0]!;
}

const BATCH_EMBED = 32; // e5-small handles 32 cleanly on M-series CPU
const BATCH_INSERT = 200;

interface RawRow {
  code: string; // 12-digit string
  ar: string;
  en: string;
  dutyAr: string;
  dutyEn: string;
  procedures: string;
}

function deriveLevels(code12: string) {
  return {
    chapter: code12.slice(0, 2),
    heading: code12.slice(0, 4),
    hs6: code12.slice(0, 6),
    hs8: code12.slice(0, 8),
    hs10: code12.slice(0, 10),
    parent10: code12.slice(0, 10),
  };
}

/** Strip the leading dash-indent from a ZATCA description and return clean text. */
function stripDashes(s: string): string {
  return s.replace(/^[-\s]+/, '').trim();
}

/**
 * Count the hierarchy depth encoded in the leading dashes of a ZATCA description.
 *   ""       → depth 0  (heading / chapter row, e.g. "Other footwear with…")
 *   "- "     → depth 1  (e.g. "- Sports footwear")
 *   "- - "   → depth 2  (e.g. "- - Other :")
 *   "- - - " → depth 3  (e.g. "- - - For men and boys")
 */
function descDepth(en: string): number {
  const m = en.match(/^(-\s*)+/);
  if (!m) return 0;
  // Each dash represents one level; count the dashes.
  return (m[0].match(/-/g) ?? []).length;
}

/**
 * Build the ancestor-enriched searchable text for one row.
 *
 * We walk backwards through the rows that precede this one in the xlsx
 * (passed in as `ancestors` — a small rolling window maintained by the
 * caller) and collect rows whose depth is strictly less than this row's
 * depth AND whose heading prefix matches.  The result is:
 *
 *   "ancestor0_stripped > ancestor1_stripped > … > leaf_stripped"
 *
 * For a non-ambiguous row like "Soccer shoes with outer soles …" (depth 0
 * within its heading) this degenerates to just the row's own text, so
 * there is no downside to running this on every row.
 */
function buildSearchableEn(
  en: string,
  heading: string,
  ancestors: Array<{ heading: string; en: string; depth: number }>,
): string {
  const myDepth = descDepth(en);
  const chain: string[] = [];
  // Collect ancestors from oldest to newest at each intermediate depth.
  for (let d = 0; d < myDepth; d++) {
    // Find the last ancestor in the window at exactly depth d with the same heading.
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const a = ancestors[i]!;
      if (a.heading === heading && a.depth === d) {
        chain.push(stripDashes(a.en));
        break;
      }
    }
  }
  chain.push(stripDashes(en));
  return chain.join(' > ');
}

/** Same logic for Arabic — dashes are absent in Arabic text, so we use the
 *  parallel EN ancestry to decide which AR ancestors to pull in. */
function buildSearchableAr(
  ar: string,
  heading: string,
  myDepth: number,
  ancestors: Array<{ heading: string; ar: string; depth: number }>,
): string {
  const chain: string[] = [];
  for (let d = 0; d < myDepth; d++) {
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const a = ancestors[i]!;
      if (a.heading === heading && a.depth === d) {
        const cleaned = (a.ar || '').trim();
        if (cleaned) chain.push(cleaned);
        break;
      }
    }
  }
  const leafAr = (ar || '').trim();
  if (leafAr) chain.push(leafAr);
  return chain.join(' > ');
}

function buildEmbeddingText(searchableEn: string, searchableAr: string): string {
  // Single passage representing both languages. e5 multilingual handles mixed text fine.
  const parts: string[] = [];
  if (searchableEn) parts.push(searchableEn);
  if (searchableAr) parts.push(searchableAr);
  return parts.join(' | ');
}

async function readXlsx(path: string): Promise<{ rows: RawRow[]; skippedHs4: number }> {
  const buf = await readFile(path);
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: false, cellNF: false });
  const ws = wb.Sheets['Grid'];
  if (!ws) throw new Error('Sheet "Grid" not found in xlsx');

  // header:1 → return rows as arrays so 12-digit codes preserve leading zeros (raw:false)
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    raw: false,
    defval: '',
  });

  const rows: RawRow[] = [];
  let skippedHs4 = 0;
  for (let i = 1; i < matrix.length; i++) {
    const r = matrix[i]!;
    const codeRaw = String(r[0] ?? '').trim();
    if (!codeRaw) continue;
    if (/^\d{4}$/.test(codeRaw)) {
      // ADR-0008: HS4 heading rows are dropped — never used in retrieval and would
      // collide with real HS12 leaves once padded.
      skippedHs4++;
      continue;
    }
    if (!/^\d{12}$/.test(codeRaw)) continue;
    rows.push({
      code: codeRaw,
      ar: String(r[1] ?? '').trim(),
      en: String(r[2] ?? '').trim(),
      dutyAr: String(r[3] ?? '').trim(),
      dutyEn: String(r[4] ?? '').trim(),
      procedures: String(r[5] ?? '').trim(),
    });
  }
  return { rows, skippedHs4 };
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const xlsxPath = await resolveXlsxPath();
  console.log(`Reading ${xlsxPath} ...`);
  const { rows: raw, skippedHs4 } = await readXlsx(xlsxPath);
  console.log(`  ${raw.length} HS12 rows parsed; ${skippedHs4} HS4 heading rows skipped (ADR-0008)`);

  const pool = getPool();

  // Truncate for repeatable seeds. Comment out if you want incremental inserts.
  await pool.query(`TRUNCATE TABLE hs_codes RESTART IDENTITY`);

  // Build inputs — every code is already 12 digits at this point.
  // We maintain a rolling ancestor window (last ~20 rows) so that each row
  // can look up its parent descriptions for the enriched searchable text.
  const ANCESTOR_WINDOW = 20;
  type AncestorEntry = { heading: string; en: string; ar: string; depth: number };
  const ancestorWindow: AncestorEntry[] = [];

  const prepared = raw.map((r) => {
    const levels = deriveLevels(r.code);
    const depth = descDepth(r.en);

    const searchEn = buildSearchableEn(r.en, levels.heading, ancestorWindow);
    const searchAr = buildSearchableAr(r.ar, levels.heading, depth, ancestorWindow);

    // Push this row into the ancestor window after computing its own enrichment.
    ancestorWindow.push({ heading: levels.heading, en: r.en, ar: r.ar, depth });
    if (ancestorWindow.length > ANCESTOR_WINDOW) ancestorWindow.shift();

    const text = buildEmbeddingText(searchEn, searchAr);
    return {
      ...r,
      code12: r.code,
      levels,
      depth,
      searchEn,
      searchAr,
      embedText: text || r.code, // fall back so we never embed empty string
    };
  });

  // Embed in batches
  console.log(`Embedding ${prepared.length} rows (batch=${BATCH_EMBED}) ...`);
  const embeddings: number[][] = [];
  let embedT = 0;
  for (let i = 0; i < prepared.length; i += BATCH_EMBED) {
    const slice = prepared.slice(i, i + BATCH_EMBED);
    const texts = slice.map((s) => s.embedText);
    const tStart = Date.now();
    const vecs = await embedPassageBatch(texts);
    embedT += Date.now() - tStart;
    embeddings.push(...vecs);
    if ((i / BATCH_EMBED) % 25 === 0) {
      const pct = ((i + slice.length) / prepared.length) * 100;
      console.log(`  ${i + slice.length}/${prepared.length}  (${pct.toFixed(1)}%)  embed_total=${embedT}ms`);
    }
  }

  // Insert in batches
  console.log(`Inserting ${prepared.length} rows ...`);
  let inserted = 0;
  for (let i = 0; i < prepared.length; i += BATCH_INSERT) {
    const slice = prepared.slice(i, i + BATCH_INSERT);
    const sliceEmb = embeddings.slice(i, i + BATCH_INSERT);

    // Build a multi-row INSERT
    const placeholders: string[] = [];
    const values: unknown[] = [];
    let p = 1;
    for (let j = 0; j < slice.length; j++) {
      const r = slice[j]!;
      const v = sliceEmb[j]!;
      const ph = [
        `$${p++}`, // code
        `$${p++}`, // chapter
        `$${p++}`, // heading
        `$${p++}`, // hs6
        `$${p++}`, // hs8
        `$${p++}`, // hs10
        `$${p++}`, // parent10
        `$${p++}`, // description_en
        `$${p++}`, // description_ar
        `$${p++}`, // duty_en
        `$${p++}`, // duty_ar
        `$${p++}`, // procedures
        `$${p++}::vector`, // embedding
        `$${p++}`, // is_leaf
        `$${p++}`, // raw_length
        `$${p++}`, // searchable_description_en  (ADR-0024)
        `$${p++}`, // searchable_description_ar  (ADR-0024)
      ].join(',');
      placeholders.push(`(${ph})`);
      values.push(
        r.code12,
        r.levels.chapter,
        r.levels.heading,
        r.levels.hs6,
        r.levels.hs8,
        r.levels.hs10,
        r.levels.parent10,
        r.en || null,
        r.ar || null,
        r.dutyEn || null,
        r.dutyAr || null,
        r.procedures || null,
        `[${v.join(',')}]`,
        true, // is_leaf — every row is a 12-digit leaf post-ADR-0008
        12,   // raw_length
        r.searchEn || null,
        r.searchAr || null,
      );
    }

    // ON CONFLICT removed: the xlsx has unique HS12 codes, and a duplicate would
    // indicate a data corruption we want to surface, not silently drop.
    const sql = `
      INSERT INTO hs_codes
        (code, chapter, heading, hs6, hs8, hs10, parent10,
         description_en, description_ar, duty_en, duty_ar, procedures,
         embedding, is_leaf, raw_length,
         searchable_description_en, searchable_description_ar)
      VALUES ${placeholders.join(',')}
    `;
    await pool.query(sql, values);
    inserted += slice.length;
    if (i % (BATCH_INSERT * 10) === 0) {
      console.log(`  ${inserted}/${prepared.length}`);
    }
  }

  // Sanity counts
  const n = await pool.query<{ count: string }>(`SELECT count(*)::text FROM hs_codes`);
  const nLeaf = await pool.query<{ count: string }>(
    `SELECT count(*)::text FROM hs_codes WHERE is_leaf = true`
  );
  console.log(`✓ ingested rows=${n.rows[0]?.count}, leaves=${nLeaf.rows[0]?.count}`);
  console.log(`Total wall time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err);
    await closeDb();
    process.exit(1);
  });
