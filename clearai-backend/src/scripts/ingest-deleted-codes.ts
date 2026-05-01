/**
 * UPSERT data/saber-deleted-codes.csv into the hs_codes table's deletion
 * columns (is_deleted, deletion_effective_date, replacement_codes).
 *
 * Usage:  pnpm db:seed:deleted
 *
 * Safe to re-run: uses UPDATE … WHERE code = $1, so existing rows are
 * refreshed and previously-unknown codes are skipped with a warning (they
 * would need to be in hs_codes first, which they always will be for any
 * legitimate SABER-listed code).
 *
 * This script is for local dev and staging. Production deletions are applied
 * via the inline-seed migration 0022_hs_codes_deletion_seed.sql which runs
 * automatically on Container App boot through migrate-and-start.ts.
 */
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { getPool, closeDb } from '../db/client.js';

const CSV_PATH = join(process.cwd(), 'data', 'saber-deleted-codes.csv');

interface DeletedRow {
  deletedCode: string;
  effectiveDate: string;
  replacementCodes: string[];
}

/** Parse the 3-column CSV produced by parse-saber-pdf.ts */
async function readDeletedCsv(path: string): Promise<DeletedRow[]> {
  const rl = createInterface({ input: createReadStream(path, 'utf8') });
  const rows: DeletedRow[] = [];
  let header = true;

  for await (const line of rl) {
    if (!line.trim()) continue;
    if (header) {
      header = false;
      continue;
    }

    // CSV: deleted_code, effective_date, replacement_codes (JSON array string)
    // The replacement_codes column is a JSON array and may contain commas,
    // so we split only on the first two commas.
    const firstComma = line.indexOf(',');
    const secondComma = line.indexOf(',', firstComma + 1);
    if (firstComma === -1 || secondComma === -1) continue;

    const deletedCode = line.slice(0, firstComma).trim();
    const effectiveDate = line.slice(firstComma + 1, secondComma).trim();
    const rcRaw = line.slice(secondComma + 1).trim().replace(/^"|"$/g, '').replace(/""/g, '"');

    let replacementCodes: string[] = [];
    try {
      replacementCodes = JSON.parse(rcRaw);
    } catch {
      // empty or malformed — treat as no alternatives
    }

    if (!deletedCode || !effectiveDate) continue;
    rows.push({ deletedCode, effectiveDate, replacementCodes });
  }

  return rows;
}

async function main(): Promise<void> {
  const t0 = Date.now();
  // eslint-disable-next-line no-console
  console.log(`Reading ${CSV_PATH} ...`);
  const rows = await readDeletedCsv(CSV_PATH);
  // eslint-disable-next-line no-console
  console.log(`  ${rows.length} deleted-code rows parsed`);

  if (rows.length === 0) {
    throw new Error('CSV had no usable rows — refusing to proceed');
  }

  const pool = getPool();
  let updated = 0;
  let notFound = 0;

  for (const row of rows) {
    const rc = row.replacementCodes.length > 0
      ? JSON.stringify(row.replacementCodes)
      : null;

    const result = await pool.query(
      `UPDATE hs_codes
          SET is_deleted              = true,
              deletion_effective_date = $2::date,
              replacement_codes       = $3::jsonb
        WHERE code = $1
          AND (is_deleted = false OR deletion_effective_date IS DISTINCT FROM $2::date)`,
      [row.deletedCode, row.effectiveDate, rc],
    );

    if ((result.rowCount ?? 0) > 0) {
      updated++;
    } else {
      // Either code not in hs_codes (genuine miss) or already up-to-date.
      const check = await pool.query<{ exists: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM hs_codes WHERE code = $1) AS exists`,
        [row.deletedCode],
      );
      if (!check.rows[0]?.exists) {
        // eslint-disable-next-line no-console
        console.warn(`  WARN: code ${row.deletedCode} not found in hs_codes — skipping`);
        notFound++;
      }
      // else already up-to-date — not an error
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `  updated ${updated} rows, ${rows.length - updated - notFound} already up-to-date, ${notFound} not found` +
    ` — done in ${Date.now() - t0}ms`,
  );

  await closeDb();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[ingest-deleted-codes] FAILED', err);
  process.exit(1);
});
