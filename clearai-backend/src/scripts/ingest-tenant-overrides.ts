/**
 * Ingest a tenant's HS-code-mapping xlsx into tenant_code_overrides.
 *
 * Renamed from ingest-broker-mapping.ts in commit #2 of ADR-0025. The slim
 * schema drops `target_description_ar`, `unit_per_price`, `source_row_ref`
 * — they were preserved-for-parity from the old design but had no readers.
 *
 * Usage:
 *   pnpm db:seed:overrides:naqel                      # default Naqel xlsx + tenant
 *   tsx ingest-tenant-overrides.ts --tenant aramex --file path/to/aramex.xlsx
 *
 * Behaviour:
 *   • Per-tenant DELETE+re-insert (other tenants are untouched).
 *   • Skips zero-padding self-maps (e.g. "61082100" → "610821000000").
 *   • Skips rows whose target_code does not exist in hs_codes (FK would
 *     reject; better to log + continue than abort the whole batch).
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ExcelJS from 'exceljs';
import { getPool, closeDb } from '../db/client.js';
import { newId } from '../util/uuid.js';

interface RawRow {
  rowRef: string;
  sourceCodeRaw: string;
  hsCodeRaw: string;
}

interface ValidatedRow {
  sourceCode: string;
  targetCode: string;
  sourceRowRef: string;
}

interface RejectedRow {
  rowRef: string;
  reason: string;
  raw: RawRow;
}

const DEFAULT_NAQEL_PATH = resolve(
  process.cwd(),
  '../naqel-shared-data/Naqel_HS_code_mapping_lookup.xlsx',
);
const DEFAULT_TENANT = 'naqel';

const DIGITS_ONLY = /[^\d]/g;

function normalizeSourceCode(s: string): string {
  return s.replace(DIGITS_ONLY, '');
}

/** Pad an HS code to a strict 12-digit form. Returns null on impossible inputs. */
function normalizeTargetCode(s: string): string | null {
  const digits = s.replace(DIGITS_ONLY, '');
  if (digits.length === 12) return digits;
  // Some source rows drop a leading zero ("10620000007" → "010620000007").
  if (digits.length === 11) return `0${digits}`;
  // 10/8-digit codes are valid HS-10/HS-8 representations; pad to strict 12.
  if (digits.length === 10) return `${digits}00`;
  if (digits.length === 8) return `${digits}0000`;
  return null;
}

/** Parse `--tenant <name>` and `--file <path>` from argv. */
function parseArgs(argv: string[]): { tenant: string; file: string } {
  let tenant = DEFAULT_TENANT;
  let file = DEFAULT_NAQEL_PATH;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tenant' && argv[i + 1]) {
      tenant = argv[++i]!;
    } else if (a === '--file' && argv[i + 1]) {
      file = argv[++i]!;
    } else if (a && !a.startsWith('--') && i === 2) {
      // Back-compat: positional arg = file path (matches old call shape).
      file = a;
    }
  }
  return { tenant, file };
}

async function readWorkbook(path: string): Promise<RawRow[]> {
  const buf = await readFile(path);
  const wb = new ExcelJS.Workbook();
  // Node 22 readFile returns NonSharedBuffer; exceljs typings need a plain
  // ArrayBuffer. The runtime representation is identical — cast is safe.
  await wb.xlsx.load(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
  );
  const ws = wb.worksheets[0];
  if (!ws) throw new Error(`No sheet found in ${path}`);

  const rows: RawRow[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return; // header
    const sourceCodeRaw = String(row.getCell(1).value ?? '').trim();
    const hsCodeRaw = String(row.getCell(2).value ?? '').trim();
    if (!sourceCodeRaw && !hsCodeRaw) return; // skip fully blank
    rows.push({
      rowRef: `R${String(rowNumber).padStart(3, '0')}`,
      sourceCodeRaw,
      hsCodeRaw,
    });
  });
  return rows;
}

function validate(raw: RawRow): ValidatedRow | RejectedRow {
  const sourceNorm = normalizeSourceCode(raw.sourceCodeRaw);
  const targetRawDigits = raw.hsCodeRaw.replace(DIGITS_ONLY, '');

  if (sourceNorm.length < 4 || sourceNorm.length > 14) {
    return {
      rowRef: raw.rowRef,
      reason: `source code length ${sourceNorm.length} out of range [4..14]`,
      raw,
    };
  }

  // Sentinel: same on both sides AND target isn't a valid 12-digit code →
  // a "do not use" marker, not a real mapping.
  if (sourceNorm === targetRawDigits && targetRawDigits.length !== 12) {
    return {
      rowRef: raw.rowRef,
      reason: `sentinel row — source and target both "${raw.hsCodeRaw}" (operations marker)`,
      raw,
    };
  }

  const target = normalizeTargetCode(raw.hsCodeRaw);
  if (!target) {
    return {
      rowRef: raw.rowRef,
      reason: `target "${raw.hsCodeRaw}" cannot be normalised to 12 digits`,
      raw,
    };
  }

  // Reject zero-padding self-maps caught by the new CHECK constraint
  // (e.g. "61082100" → "610821000000"). Old ingest let these through;
  // the new schema would reject them at INSERT.
  if (sourceNorm.padEnd(12, '0') === target) {
    return {
      rowRef: raw.rowRef,
      reason: `zero-padding self-map (rpad("${sourceNorm}", 12, '0') === "${target}")`,
      raw,
    };
  }

  return {
    sourceCode: sourceNorm,
    targetCode: target,
    sourceRowRef: raw.rowRef,
  };
}

function isValidated(v: ValidatedRow | RejectedRow): v is ValidatedRow {
  return 'sourceCode' in v;
}

async function main(): Promise<void> {
  const { tenant, file } = parseArgs(process.argv);

  console.log(`[ingest-tenant-overrides] tenant=${tenant} file=${file}`);
  if (!/^[a-z][a-z0-9_]{2,31}$/.test(tenant)) {
    console.error(
      `[ingest-tenant-overrides] tenant slug "${tenant}" must match /^[a-z][a-z0-9_]{2,31}$/ (CHECK constraint).`,
    );
    process.exit(1);
  }

  const raw = await readWorkbook(file);
  console.log(`[ingest-tenant-overrides] ${raw.length} non-empty data rows`);

  const validated: ValidatedRow[] = [];
  const rejected: RejectedRow[] = [];
  // Detect duplicate source codes within the source file.
  const seenSource = new Map<string, string>();
  for (const r of raw) {
    const v = validate(r);
    if (!isValidated(v)) {
      rejected.push(v);
      continue;
    }
    const prior = seenSource.get(v.sourceCode);
    if (prior) {
      rejected.push({
        rowRef: v.sourceRowRef,
        reason: `duplicate source code ${v.sourceCode} (first seen at ${prior})`,
        raw: r,
      });
      continue;
    }
    seenSource.set(v.sourceCode, v.sourceRowRef);
    validated.push(v);
  }

  console.log(
    `[ingest-tenant-overrides] valid: ${validated.length}, rejected: ${rejected.length}`,
  );
  if (rejected.length > 0) {
    console.log('[ingest-tenant-overrides] rejection details:');
    for (const r of rejected) {
      console.log(
        `  ${r.rowRef}: ${r.reason}  (source="${r.raw.sourceCodeRaw}" → hs="${r.raw.hsCodeRaw}")`,
      );
    }
  }

  if (validated.length === 0) {
    console.error('[ingest-tenant-overrides] no valid rows — aborting before DELETE');
    return;
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Per-tenant delete — leaves other tenants' rules intact.
    await client.query('DELETE FROM tenant_code_overrides WHERE tenant = $1', [tenant]);

    // Pre-filter against hs_codes so we can report which targets don't exist
    // (rather than abort the whole batch on the FK).
    const targetSet = Array.from(new Set(validated.map((v) => v.targetCode)));
    const liveTargets = await client.query<{ code: string }>(
      `SELECT code FROM zatca_hs_codes WHERE code = ANY($1::char(12)[])`,
      [targetSet],
    );
    const liveSet = new Set(liveTargets.rows.map((r) => r.code));
    const droppedMissing: ValidatedRow[] = [];
    const insertable: ValidatedRow[] = [];
    for (const v of validated) {
      if (liveSet.has(v.targetCode)) insertable.push(v);
      else droppedMissing.push(v);
    }
    if (droppedMissing.length > 0) {
      console.log(
        `[ingest-tenant-overrides] dropping ${droppedMissing.length} rows whose target is not in hs_codes:`,
      );
      for (const v of droppedMissing.slice(0, 20)) {
        console.log(`  ${v.sourceRowRef}: ${v.sourceCode} → ${v.targetCode} (target absent)`);
      }
      if (droppedMissing.length > 20) {
        console.log(`  … and ${droppedMissing.length - 20} more`);
      }
    }

    // Bulk insert via UNNEST — keeps the transaction tight for large batches.
    // ids are generated TS-side (UUIDv7); the DB default gen_random_uuid()
    // is the safety net for any path that doesn't supply one.
    await client.query(
      `INSERT INTO tenant_code_overrides (id, tenant, source_code, target_code)
       SELECT id, $1, src, tgt FROM UNNEST(
         $2::uuid[],
         $3::varchar[],
         $4::varchar[]
       ) AS u(id, src, tgt)`,
      [
        tenant,
        insertable.map(() => newId()),
        insertable.map((v) => v.sourceCode),
        insertable.map((v) => v.targetCode),
      ],
    );

    await client.query('COMMIT');
    console.log(
      `[ingest-tenant-overrides] ✓ inserted ${insertable.length} rows under tenant=${tenant}`,
    );
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[ingest-tenant-overrides] insert failed, rolled back:', err);
    process.exit(1);
  } finally {
    client.release();
  }
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err);
    await closeDb();
    process.exit(1);
  });
