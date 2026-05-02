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

/**
 * Parse a ZATCA duty cell into the structured shape persisted in
 * hs_codes.duty_rate_pct + hs_codes.duty_status (post-0031). Mirrors
 * the SQL backfill in 0031 so a fresh xlsx ingest produces the same
 * shape as the in-place migration.
 */
function parseDutyCell(raw: string): { ratePct: number | null; status: string | null } {
  const t = raw.trim();
  if (!t) return { ratePct: null, status: null };
  const m = t.match(/^(\d+(?:\.\d+)?)\s*%\s*$/);
  if (m) {
    const n = Number(m[1]);
    return Number.isFinite(n) ? { ratePct: n, status: 'rate' } : { ratePct: null, status: null };
  }
  switch (t.toLowerCase()) {
    case 'exempted':
      return { ratePct: null, status: 'exempted' };
    case 'prohibited from importing':
      return { ratePct: null, status: 'prohibited_import' };
    case 'prohibited from exporting':
      return { ratePct: null, status: 'prohibited_export' };
    case 'prohibited from exporting and importing':
      return { ratePct: null, status: 'prohibited_both' };
    default:
      return { ratePct: null, status: null };
  }
}

/** Comma-list "61,98" → ['61','98'] | null on empty. Mirrors 0031 backfill. */
function parseProceduresCell(raw: string): string[] | null {
  const cleaned = raw.replace(/\s+/g, '');
  if (!cleaned) return null;
  const arr = cleaned.split(',').filter(Boolean);
  return arr.length ? arr : null;
}

function deriveLevels(code12: string) {
  return {
    chapter: code12.slice(0, 2),
    heading: code12.slice(0, 4),
    hs6: code12.slice(0, 6),
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
  await pool.query(`TRUNCATE TABLE zatca_hs_codes RESTART IDENTITY CASCADE`);

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
      const duty = parseDutyCell(r.dutyEn);
      const procArr = parseProceduresCell(r.procedures);
      const ph = [
        `$${p++}`, // id (UUIDv7, TS-generated)
        `$${p++}`, // code
        `$${p++}`, // chapter
        `$${p++}`, // heading
        `$${p++}`, // hs6
        `$${p++}`, // description_en
        `$${p++}`, // description_ar
        `$${p++}`, // duty_rate_pct
        `$${p++}`, // duty_status
        `$${p++}::text[]`, // procedures
      ].join(',');
      placeholders.push(`(${ph})`);
      values.push(
        newId(), // UUIDv7 — time-ordered, btree-friendly during bulk load
        r.code12,
        r.levels.chapter,
        r.levels.heading,
        r.levels.hs6,
        r.en || null,
        r.ar || null,
        duty.ratePct,
        duty.status,
        procArr,
      );
    }

    // ON CONFLICT removed: the xlsx has unique HS12 codes, and a duplicate would
    // indicate a data corruption we want to surface, not silently drop.
    const sql = `
      INSERT INTO zatca_hs_codes
        (id, code, chapter, heading, hs6,
         description_en, description_ar, duty_rate_pct, duty_status, procedures)
      VALUES ${placeholders.join(',')}
    `;
    await pool.query(sql, values);
    inserted += slice.length;
    if (i % (BATCH_INSERT * 10) === 0) {
      console.log(`  ${inserted}/${prepared.length}`);
    }
  }

  // Sanity counts.
  const n = await pool.query<{ count: string }>(`SELECT count(*)::text FROM zatca_hs_codes`);
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
