/**
 * UPSERT data/procedure-codes.csv into procedure_codes. Detects the (ملغي)
 * repealed marker; skips rows with empty descriptions.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getPool, closeDb } from '../db/client.js';

const CSV_PATH = join(process.cwd(), 'data', 'procedure-codes.csv');

const REPEALED_RE = /\(\s*ملغي\s*\)\s*$/u;

interface RawProcedure {
  code: string;
  descriptionAr: string;
  isRepealed: boolean;
}

/** 2-column CSV parser; handles quoted fields. No multi-line quoted strings. */
function parseCsvLine(line: string): [string, string] | null {
  if (!line.trim()) return null;
  const fields: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === ',') {
        fields.push(cur);
        cur = '';
      } else if (ch === '"' && cur === '') {
        inQuotes = true;
      } else {
        cur += ch;
      }
    }
  }
  fields.push(cur);
  if (fields.length < 2) return null;
  return [fields[0]!.trim(), fields[1]!.trim()];
}

async function readProcedureCsv(path: string): Promise<{
  rows: RawProcedure[];
  skippedEmpty: string[];
}> {
  const text = await readFile(path, 'utf8');
  const lines = text.split(/\r?\n/);
  const rows: RawProcedure[] = [];
  const skippedEmpty: string[] = [];
  let header = true;
  for (const line of lines) {
    const parsed = parseCsvLine(line);
    if (!parsed) continue;
    if (header) {
      header = false;
      continue;
    }
    const [code, desc] = parsed;
    if (!code) continue;
    if (!desc) {
      skippedEmpty.push(code);
      continue;
    }
    rows.push({
      code,
      descriptionAr: desc,
      isRepealed: REPEALED_RE.test(desc),
    });
  }
  return { rows, skippedEmpty };
}

async function main(): Promise<void> {
  const t0 = Date.now();
  // eslint-disable-next-line no-console
  console.log(`Reading ${CSV_PATH} ...`);
  const { rows, skippedEmpty } = await readProcedureCsv(CSV_PATH);
  // eslint-disable-next-line no-console
  console.log(
    `  ${rows.length} procedure codes parsed (${rows.filter((r) => r.isRepealed).length} repealed)`,
  );
  if (skippedEmpty.length > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `  ${skippedEmpty.length} placeholder rows skipped (empty descriptions): ${skippedEmpty.join(', ')}`,
    );
  }

  if (rows.length === 0) {
    throw new Error('CSV had no usable rows — refusing to wipe procedure_codes');
  }

  const pool = getPool();
  // Single multi-row UPSERT. 111 rows = trivial — no batching needed.
  const valuesSql: string[] = [];
  const params: (string | boolean)[] = [];
  let p = 1;
  for (const row of rows) {
    valuesSql.push(`($${p++}, $${p++}, $${p++})`);
    params.push(row.code, row.descriptionAr, row.isRepealed);
  }

  const sql = `
    INSERT INTO procedure_codes (code, description_ar, is_repealed)
    VALUES ${valuesSql.join(', ')}
    ON CONFLICT (code) DO UPDATE SET
      description_ar = EXCLUDED.description_ar,
      is_repealed    = EXCLUDED.is_repealed,
      updated_at     = now()
  `;
  const result = await pool.query(sql, params);

  // eslint-disable-next-line no-console
  console.log(
    `  upserted ${result.rowCount} rows in ${Date.now() - t0}ms`,
  );

  await closeDb();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[ingest-procedure-codes] FAILED', err);
  process.exit(1);
});
