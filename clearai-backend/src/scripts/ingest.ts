/**
 * Ingest the ZATCA Tariff codes.xlsx into the slim hs_codes table
 * (ADR-0025 source-of-truth catalog only — no embeddings, no tsv, no
 * derived display data).
 *
 * After running this:
 *   pnpm db:seed:display    # populate hs_code_display
 *   pnpm db:seed:search     # populate hs_code_search (~16 min)
 *   pnpm db:seed:deleted    # apply SABER deletion flags
 *   pnpm db:seed:overrides:naqel  # populate tenant_code_overrides
 *
 * The xlsx is the source of truth for the catalog; we TRUNCATE + reload.
 */
import * as XLSX from 'xlsx';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { getPool, closeDb } from '../db/client.js';
import { newId } from '../util/uuid.js';

// XLSX_PATH resolution order (first match wins):
//   1. ZATCA_XLSX env override — set in .env.local for CI / custom paths
//   2. naqel-shared-data/ sibling of the repo root (local dev convention)
//   3. Legacy clearai-backend-python/data/ path (kept for back-compat)
async function resolveXlsxPath(): Promise<string> {
  if (process.env['ZATCA_XLSX']) return process.env['ZATCA_XLSX'];
  const candidates = [
    join(process.cwd(), '..', 'naqel-shared-data', 'Zatca Tariff codes.xlsx'),
    join(process.cwd(), '..', 'clearai-backend-python', 'data', 'Zatca Tariff codes.xlsx'),
  ];
  for (const p of candidates) {
    try { await access(p); return p; } catch { /* try next */ }
  }
  return candidates[0]!;
}

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

  // Truncate for repeatable seeds. CASCADE because hs_code_display + hs_code_search
  // both FK to hs_codes(code) ON DELETE CASCADE — they get cleared too. Run their
  // ingest scripts after this to re-populate.
  await pool.query(`TRUNCATE TABLE hs_codes RESTART IDENTITY CASCADE`);

  // Build inputs.
  const prepared = raw.map((r) => ({
    ...r,
    code12: r.code,
    levels: deriveLevels(r.code),
  }));

  // Insert in batches.
  console.log(`Inserting ${prepared.length} rows ...`);
  let inserted = 0;
  for (let i = 0; i < prepared.length; i += BATCH_INSERT) {
    const slice = prepared.slice(i, i + BATCH_INSERT);

    const placeholders: string[] = [];
    const values: unknown[] = [];
    let p = 1;
    for (const r of slice) {
      const ph = [
        `$${p++}`, // id (UUIDv7, TS-generated)
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
      ].join(',');
      placeholders.push(`(${ph})`);
      values.push(
        newId(), // UUIDv7 — time-ordered, btree-friendly during bulk load
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
      );
    }

    // ON CONFLICT removed: the xlsx has unique HS12 codes, and a duplicate would
    // indicate a data corruption we want to surface, not silently drop.
    // id supplied explicitly (UUIDv7); DB default gen_random_uuid() is left in
    // place as a safety net for any legacy INSERT path that doesn't yet
    // supply the column.
    const sql = `
      INSERT INTO hs_codes
        (id, code, chapter, heading, hs6, hs8, hs10, parent10,
         description_en, description_ar, duty_en, duty_ar, procedures)
      VALUES ${placeholders.join(',')}
    `;
    await pool.query(sql, values);
    inserted += slice.length;
    if (i % (BATCH_INSERT * 10) === 0) {
      console.log(`  ${inserted}/${prepared.length}`);
    }
  }

  // Sanity counts.
  const n = await pool.query<{ count: string }>(`SELECT count(*)::text FROM hs_codes`);
  console.log(`✓ ingested rows=${n.rows[0]?.count}`);
  console.log(`Total wall time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('\nNext steps:');
  console.log('  pnpm db:seed:display          # build hs_code_display');
  console.log('  pnpm db:seed:search           # build hs_code_search (~16 min)');
  console.log('  pnpm db:seed:deleted          # apply SABER deletion flags');
  console.log('  pnpm db:seed:overrides:naqel  # populate tenant_code_overrides');
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err);
    await closeDb();
    process.exit(1);
  });
