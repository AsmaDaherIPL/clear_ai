/**
 * XLSX parser. Reads the first worksheet of the uploaded workbook into raw
 * Record<string,string>[] rows; no business logic.
 *
 * Uses XLSX.read({ type: 'buffer' }) so the caller can pass an in-memory
 * Buffer (multipart upload) without ever hitting disk. Cells are stringified
 * via {raw: false} so dates, formulas and numbers are formatted as the user
 * sees them in the spreadsheet — the canonicaliser handles numeric coercion
 * downstream.
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

  // raw:false -> formatted strings (matches what the user sees).
  // defval:'' -> absent cells become '' rather than undefined, simplifies callers.
  const rowsAsObjects = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    raw: false,
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
      const v = r[k];
      out[k.trim()] = v === undefined || v === null ? '' : String(v);
    }
    return out;
  });

  return { headers, rows };
}
