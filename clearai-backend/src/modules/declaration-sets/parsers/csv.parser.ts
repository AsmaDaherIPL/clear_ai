/**
 * CSV parser. Returns raw rows as Record<string,string>[]; no business logic.
 *
 * Reads the entire buffer (uploads are size-capped by BATCH_INPUT_MAX_ROWS),
 * splits on \r?\n, and pairs cells against the header line. Quoted cells
 * (RFC-4180 minimal subset) are supported: quotes, escaped doubled quotes,
 * embedded commas, embedded newlines.
 *
 * Throws CsvParseError on malformed quoting or duplicate header names.
 * Empty trailing lines are dropped silently.
 */

export class CsvParseError extends Error {
  readonly code = 'csv_parse_error';
  constructor(message: string, readonly lineNumber: number) {
    super(message);
    this.name = 'CsvParseError';
  }
}

interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
}

/** Tokenize one logical CSV record starting at offset; returns [cells, newOffset]. */
function readRecord(src: string, start: number): [string[], number] {
  const cells: string[] = [];
  let i = start;
  let cell = '';
  let inQuote = false;

  while (i < src.length) {
    const ch = src[i]!;
    if (inQuote) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuote = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuote = true;
      i++;
      continue;
    }
    if (ch === ',') {
      cells.push(cell);
      cell = '';
      i++;
      continue;
    }
    if (ch === '\r') {
      // CRLF or lone CR end-of-record.
      if (src[i + 1] === '\n') i++;
      i++;
      cells.push(cell);
      return [cells, i];
    }
    if (ch === '\n') {
      i++;
      cells.push(cell);
      return [cells, i];
    }
    cell += ch;
    i++;
  }
  if (inQuote) {
    throw new CsvParseError('unterminated quoted field', countLines(src, start));
  }
  cells.push(cell);
  return [cells, i];
}

function countLines(src: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src[i] === '\n') n++;
  return n;
}

export function parseCsvBuffer(buf: Buffer): ParsedCsv {
  // Strip BOM if present; UTF-8 only.
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  if (text.length === 0) {
    throw new CsvParseError('empty file', 1);
  }

  let offset = 0;
  // First record = headers.
  const [rawHeaders, afterHeader] = readRecord(text, offset);
  offset = afterHeader;
  const headers = rawHeaders.map((h) => h.trim());

  const seen = new Set<string>();
  for (const h of headers) {
    if (h === '') {
      throw new CsvParseError('empty header cell', 1);
    }
    if (seen.has(h)) {
      throw new CsvParseError(`duplicate header '${h}'`, 1);
    }
    seen.add(h);
  }

  const rows: Record<string, string>[] = [];
  while (offset < text.length) {
    const [cells, next] = readRecord(text, offset);
    offset = next;
    // Skip blank lines.
    if (cells.length === 1 && cells[0] === '') continue;
    if (cells.length !== headers.length) {
      throw new CsvParseError(
        `row has ${cells.length} cells, header has ${headers.length}`,
        countLines(text, offset),
      );
    }
    const row: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      row[headers[c]!] = cells[c] ?? '';
    }
    rows.push(row);
  }

  return { headers, rows };
}
