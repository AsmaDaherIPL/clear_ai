/**
 * XLSX parser. Reads the first worksheet of the uploaded workbook into raw
 * Record<string,string>[] rows; no business logic.
 *
 * Cell value strategy:
 *   - We read with raw:true so we receive the underlying JS values (numbers,
 *     booleans, dates) rather than Excel's display strings. Display strings
 *     are catastrophic for any column that holds a 12-digit-ish integer
 *     (HS codes, waybills, GTINs): Excel formats `851830000000` as
 *     `"8.5183E+11"`. With raw:false the parser would later strip non-digits
 *     and produce `"8518311"` — a confidently-wrong 7-digit prefix.
 *   - Numbers are stringified with `String(n)` for safe ints, or
 *     `n.toFixed(0)` when the value is a large integer that would otherwise
 *     be rendered with exponent notation.
 *   - Dates and strings pass through. Booleans become "true"/"false".
 */
import * as XLSX from 'xlsx';

export class XlsxParseError extends Error {
  readonly code = 'xlsx_parse_error';
  constructor(message: string) {
    super(message);
    this.name = 'XlsxParseError';
  }
}

interface ParsedXlsx {
  headers: string[];
  rows: Record<string, string>[];
}

function cellToString(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '';
    // Integer values must round-trip without exponent notation. JS `String(n)`
    // already does this for integers up to 1e21 — but for safety, format
    // explicitly when the value is a large integer (anything Excel would
    // otherwise render in scientific notation in a numeric cell).
    if (Number.isInteger(v) && Math.abs(v) >= 1e10) {
      return v.toFixed(0);
    }
    return String(v);
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

export function parseXlsxBuffer(buf: Buffer): ParsedXlsx {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buf, { type: 'buffer' });
  } catch (err) {
    throw new XlsxParseError(`failed to parse workbook: ${(err as Error).message}`);
  }
  const firstSheetName = wb.SheetNames[0];
  if (!firstSheetName) {
    throw new XlsxParseError('workbook has no sheets');
  }
  const sheet = wb.Sheets[firstSheetName];
  if (!sheet) {
    throw new XlsxParseError(`sheet '${firstSheetName}' is empty`);
  }

  // raw:true -> underlying JS values (numbers, booleans, Dates) rather
  //             than Excel's formatted display strings. Required so a
  //             12-digit HS code stored as a number does not arrive as
  //             "8.5183E+11" and get stripped to a 7-digit nonsense prefix.
  // defval:'' -> absent cells become '' rather than undefined.
  const rowsAsObjects = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    raw: true,
    defval: '',
  });
  if (rowsAsObjects.length === 0) {
    return { headers: [], rows: [] };
  }

  // sheet_to_json picks header order from the first non-empty row of the
  // sheet; we replay that to produce a stable header list. Trim header
  // strings to be tolerant of trailing whitespace from spreadsheet authors.
  const headerSet = new Set<string>();
  for (const r of rowsAsObjects) {
    for (const k of Object.keys(r)) headerSet.add(k.trim());
  }
  const headers = [...headerSet];

  const rows: Record<string, string>[] = rowsAsObjects.map((r) => {
    const out: Record<string, string> = {};
    for (const k of Object.keys(r)) {
      out[k.trim()] = cellToString(r[k]);
    }
    return out;
  });

  return { headers, rows };
}
