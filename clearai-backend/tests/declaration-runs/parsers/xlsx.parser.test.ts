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

  it('preserves 12-digit integer cells (HS codes) without scientific-notation truncation', () => {
    // Excel renders 851830000000 as "8.5183E+11" in display mode. Prior to
    // 2026-05-10 we read with raw:false, then stripped non-digits downstream
    // and ended up with "8518311" — a confidently wrong 7-digit prefix.
    // raw:true gives us the underlying number; we round-trip via toFixed(0).
    const buf = makeXlsx(['Description', 'CustomsCommodityCode'], [
      ['Wireless headphones with bluetooth', 851830000000],
      ['Clothes Storage Basket', 630791000000],
    ]);
    const { rows } = parseXlsxBuffer(buf);
    expect(rows[0]!.CustomsCommodityCode).toBe('851830000000');
    expect(rows[1]!.CustomsCommodityCode).toBe('630791000000');
  });

  it('preserves shorter HS codes (8 / 10 digits) as-is', () => {
    const buf = makeXlsx(['HS6', 'HS8', 'HS10'], [[851830, 85183090, 8518309000]]);
    const { rows } = parseXlsxBuffer(buf);
    expect(rows[0]!.HS6).toBe('851830');
    expect(rows[0]!.HS8).toBe('85183090');
    expect(rows[0]!.HS10).toBe('8518309000');
  });

  it('keeps small numbers in regular notation', () => {
    const buf = makeXlsx(['Quantity', 'Amount'], [[1, 49.33]]);
    const { rows } = parseXlsxBuffer(buf);
    expect(rows[0]!.Quantity).toBe('1');
    expect(rows[0]!.Amount).toBe('49.33');
  });
});
