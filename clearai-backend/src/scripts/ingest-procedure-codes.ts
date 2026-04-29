/**
 * Ingest the ZATCA procedures-codes lookup into `procedure_codes`.
 *
 * Source of truth: `clearai-backend/data/procedure-codes.csv` —
 * a verbatim copy of the official ZATCA guide
 * (دليل رموز إجراءات فسح وتصدير السلع), Arabic-only descriptions,
 * codes 1–113 with gaps. The CSV is committed alongside the schema so
 * a fresh checkout can `pnpm db:seed:procedures` without external assets.
 *
 * UPSERT-on-(code) so re-running is safe: an updated CSV (e.g. ZATCA
 * publishes a revision and we replace the file) re-syncs the table
 * in-place without dropping rows that might still be referenced from
 * trace logs.
 *
 * `(ملغي)` suffix detection: ~25 of the 111 descriptions end with
 * "(ملغي)" indicating the procedure is repealed. We materialise this
 * into the `is_repealed` boolean for fast filtering at response time
 * — the description text keeps the suffix verbatim because it's part
 * of the official record.
 *
 * Empty-description rows (codes 43, 73, 83 in the current CSV) are
 * logged and skipped — those are placeholder entries in the source
 * and surfacing them would mislead brokers. If ZATCA later fills them
 * in, a re-ingest picks them up.
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

/**
 * Minimal CSV parser — handles double-quoted fields and escaped quotes.
 * Avoids pulling in a CSV dependency for a one-script use case. Two
 * columns only (code, description), so we stop after the second field.
 *
 * Doesn't handle multi-line quoted strings — the source CSV is
 * single-line per record, so this is enough.
 */
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
