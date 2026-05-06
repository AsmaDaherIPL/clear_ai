import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { parseXlsxBuffer, XlsxParseError } from '../../../src/modules/declaration-runs/parsers/xlsx.parser.js';

function makeXlsx(headers: string[], data: Array<Array<string | number>>): Buffer {
  const aoa = [headers, ...data];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

describe('parseXlsxBuffer', () => {
  it('parses a simple sheet to {headers, rows}', () => {
    const buf = makeXlsx(['Description', 'Value'], [
      ['Cotton', 100],
      ['Wool', 200],
    ]);
    const { headers, rows } = parseXlsxBuffer(buf);
    expect(headers).toContain('Description');
    expect(headers).toContain('Value');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ Description: 'Cotton', Value: '100' });
    expect(rows[1]).toEqual({ Description: 'Wool', Value: '200' });
  });

  it('returns empty result for an empty sheet', () => {
    const buf = makeXlsx([], []);
    const { headers, rows } = parseXlsxBuffer(buf);
    expect(headers).toEqual([]);
    expect(rows).toEqual([]);
  });

  it('trims whitespace in header names', () => {
    const buf = makeXlsx(['  Description  ', 'Value'], [['x', 1]]);
    const { rows } = parseXlsxBuffer(buf);
    expect(Object.keys(rows[0]!)).toEqual(['Description', 'Value']);
  });

  it('returns empty result for an obviously malformed buffer', () => {
    // SheetJS is permissive — many "garbage" buffers parse as empty workbooks
    // rather than throwing. We assert the safe upper-bound behaviour: either
    // an XlsxParseError, or an empty {headers, rows}.
    try {
      const out = parseXlsxBuffer(Buffer.from('not an xlsx', 'utf8'));
      expect(out.rows).toEqual([]);
    } catch (err) {
      expect(err).toBeInstanceOf(XlsxParseError);
    }
  });
});
