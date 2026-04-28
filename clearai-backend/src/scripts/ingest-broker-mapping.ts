/**
 * Ingest the broker's hand-curated HS-code mapping lookup into
 * `broker_code_mapping`.
 *
 * Source: clear_ai/naqel-shared-data/Naqel_HS_code_mapping_lookup.xlsx
 * Target: postgres table `broker_code_mapping` (migration 0012)
 *
 * Behaviour:
 *   - Reads the xlsx, filters out invalid rows (logs each rejection with
 *     reason), normalises the client code to digits-only, normalises the
 *     target code to 12-digit zero-padded form.
 *   - TRUNCATEs the table inside a single transaction, then bulk-inserts.
 *     The source file IS the source of truth — we don't merge or diff,
 *     because edits happen in Excel and we want the DB to reflect the
 *     latest sheet exactly.
 *   - Reports a summary at the end (imported, skipped, by-rejection-reason).
 *
 * Run with:
 *   pnpm tsx src/scripts/ingest-broker-mapping.ts
 *   pnpm tsx src/scripts/ingest-broker-mapping.ts /custom/path/to/file.xlsx
 *
 * Idempotent: re-running with the same file produces the same DB state.
 * If the source file shrinks (rows removed), the DB shrinks too (TRUNCATE
 * before INSERT is intentional).
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ExcelJS from 'exceljs';
import { getPool, closeDb } from '../db/client.js';

interface RawRow {
  rowRef: string;
  clientCodeRaw: string;
  hsCodeRaw: string;
  unitPerPrice: number | null;
  arabicName: string | null;
}

interface ValidatedRow {
  clientCodeNorm: string;
  targetCode: string;
  targetDescriptionAr: string | null;
  unitPerPrice: number | null;
  sourceRowRef: string;
}

interface RejectedRow {
  rowRef: string;
  reason: string;
  raw: RawRow;
}

const DEFAULT_PATH = resolve(
  process.cwd(),
  '../naqel-shared-data/Naqel_HS_code_mapping_lookup.xlsx',
);

const DIGITS_ONLY = /[^\d]/g;

function normalizeClientCode(s: string): string {
  return s.replace(DIGITS_ONLY, '');
}

/** Pad an HS code to a strict 12-digit form. Returns null on impossible inputs. */
function normalizeTargetCode(s: string): string | null {
  const digits = s.replace(DIGITS_ONLY, '');
  if (digits.length === 12) return digits;
  // The source file has 7 rows where the broker forgot a leading zero
  // ("10620000007" → meant "010620000007", which becomes "010620000007").
  // We accept 11-digit inputs and prepend a 0 — but only when that
  // produces a 12-digit string. Anything shorter is too ambiguous to
  // auto-pad and is rejected.
  if (digits.length === 11) return `0${digits}`;
  // 10-digit → pad with two trailing zeros (10-digit codes are valid HS-10
  // representation but we want the strict 12-digit form for the target column).
  if (digits.length === 10) return `${digits}00`;
  // 8-digit → pad with four trailing zeros.
  if (digits.length === 8) return `${digits}0000`;
  return null;
}

async function readWorkbook(path: string): Promise<RawRow[]> {
  const buf = await readFile(path);
  const wb = new ExcelJS.Workbook();
  // Node 22's readFile() returns NonSharedBuffer (a stricter Buffer subtype)
  // which exceljs's older typings don't accept directly. The runtime
  // representation is identical — the cast is safe.
  await wb.xlsx.load(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error(`No sheet found in ${path}`);

  const rows: RawRow[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return; // header
    const clientCodeRaw = String(row.getCell(1).value ?? '').trim();
    const hsCodeRaw = String(row.getCell(2).value ?? '').trim();
    const upRaw = row.getCell(3).value;
    const arRaw = row.getCell(4).value;
    if (!clientCodeRaw && !hsCodeRaw) return; // skip fully blank
    rows.push({
      rowRef: `R${String(rowNumber).padStart(3, '0')}`,
      clientCodeRaw,
      hsCodeRaw,
      unitPerPrice:
        typeof upRaw === 'number' ? upRaw : upRaw == null || upRaw === '' ? null : Number(upRaw) || null,
      arabicName: arRaw == null ? null : String(arRaw).trim() || null,
    });
  });
  return rows;
}

function validate(raw: RawRow): ValidatedRow | RejectedRow {
  const clientNorm = normalizeClientCode(raw.clientCodeRaw);
  const targetRawDigits = raw.hsCodeRaw.replace(DIGITS_ONLY, '');

  if (clientNorm.length < 4 || clientNorm.length > 14) {
    return {
      rowRef: raw.rowRef,
      reason: `client code length ${clientNorm.length} out of range [4..14]`,
      raw,
    };
  }

  // Sentinel detection: when the broker put the same code on both sides
  // *and* the target is not a valid 12-digit code as written, the row is
  // a "do not use" marker rather than a real mapping. Auto-padding it
  // would manufacture a fake target — strictly worse than rejecting.
  if (clientNorm === targetRawDigits && targetRawDigits.length !== 12) {
    return {
      rowRef: raw.rowRef,
      reason: `sentinel row — client and target both "${raw.hsCodeRaw}" with non-12-digit target (broker's "do not use" marker)`,
      raw,
    };
  }

  const target = normalizeTargetCode(raw.hsCodeRaw);
  if (!target) {
    return {
      rowRef: raw.rowRef,
      reason: `target code "${raw.hsCodeRaw}" cannot be normalised to 12 digits`,
      raw,
    };
  }
  if (clientNorm === target) {
    return {
      rowRef: raw.rowRef,
      reason: `self-map (client == target after normalisation, almost certainly a data error)`,
      raw,
    };
  }
  return {
    clientCodeNorm: clientNorm,
    targetCode: target,
    targetDescriptionAr: raw.arabicName,
    unitPerPrice: raw.unitPerPrice,
    sourceRowRef: raw.rowRef,
  };
}

function isValidated(v: ValidatedRow | RejectedRow): v is ValidatedRow {
  return 'clientCodeNorm' in v;
}

async function main(): Promise<void> {
  const argPath = process.argv[2];
  const path = argPath ?? DEFAULT_PATH;

  // eslint-disable-next-line no-console
  console.log(`[ingest-broker-mapping] reading ${path}`);
  const raw = await readWorkbook(path);
  // eslint-disable-next-line no-console
  console.log(`[ingest-broker-mapping] ${raw.length} non-empty data rows`);

  const validated: ValidatedRow[] = [];
  const rejected: RejectedRow[] = [];
  // Detect duplicate client codes within the source file. Two source rows
  // with the same input is a data error — the broker can only canonically
  // map one input to one target.
  const seenClient = new Map<string, string>();
  for (const r of raw) {
    const v = validate(r);
    if (!isValidated(v)) {
      rejected.push(v);
      continue;
    }
    const prior = seenClient.get(v.clientCodeNorm);
    if (prior) {
      rejected.push({
        rowRef: v.sourceRowRef,
        reason: `duplicate client code ${v.clientCodeNorm} (first seen at ${prior})`,
        raw: r,
      });
      continue;
    }
    seenClient.set(v.clientCodeNorm, v.sourceRowRef);
    validated.push(v);
  }

  // eslint-disable-next-line no-console
  console.log(
    `[ingest-broker-mapping] valid: ${validated.length}, rejected: ${rejected.length}`,
  );
  if (rejected.length > 0) {
    // eslint-disable-next-line no-console
    console.log('[ingest-broker-mapping] rejection details:');
    for (const r of rejected) {
      // eslint-disable-next-line no-console
      console.log(
        `  ${r.rowRef}: ${r.reason}  (client="${r.raw.clientCodeRaw}" → hs="${r.raw.hsCodeRaw}")`,
      );
    }
  }

  if (validated.length === 0) {
    // eslint-disable-next-line no-console
    console.error('[ingest-broker-mapping] no valid rows — aborting before TRUNCATE');
    return;
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE TABLE broker_code_mapping RESTART IDENTITY');

    // Bulk insert via UNNEST — much faster than per-row INSERTs and keeps
    // the transaction tight even if the table grows 10x.
    await client.query(
      `INSERT INTO broker_code_mapping
        (client_code_norm, target_code, target_description_ar, unit_per_price, source_row_ref)
       SELECT * FROM UNNEST(
         $1::varchar[],
         $2::varchar[],
         $3::text[],
         $4::numeric[],
         $5::varchar[]
       )`,
      [
        validated.map((v) => v.clientCodeNorm),
        validated.map((v) => v.targetCode),
        validated.map((v) => v.targetDescriptionAr),
        validated.map((v) => v.unitPerPrice),
        validated.map((v) => v.sourceRowRef),
      ],
    );

    await client.query('COMMIT');
    // eslint-disable-next-line no-console
    console.log(`[ingest-broker-mapping] ✓ inserted ${validated.length} rows`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // eslint-disable-next-line no-console
    console.error('[ingest-broker-mapping] insert failed, rolled back:', err);
    process.exit(1);
  } finally {
    client.release();
  }
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    await closeDb();
    process.exit(1);
  });
