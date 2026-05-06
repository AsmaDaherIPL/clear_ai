import { describe, expect, it } from 'vitest';
import { parseCsvBuffer, CsvParseError } from '../../../src/modules/declaration-runs/parsers/csv.parser.js';

const buf = (s: string): Buffer => Buffer.from(s, 'utf8');

describe('parseCsvBuffer', () => {
  it('parses a simple file with LF newlines', () => {
    const { headers, rows } = parseCsvBuffer(buf('a,b,c\n1,2,3\n4,5,6\n'));
    expect(headers).toEqual(['a', 'b', 'c']);
    expect(rows).toEqual([
      { a: '1', b: '2', c: '3' },
      { a: '4', b: '5', c: '6' },
    ]);
  });

  it('parses CRLF line endings', () => {
    const { rows } = parseCsvBuffer(buf('a,b\r\n1,2\r\n3,4\r\n'));
    expect(rows).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ]);
  });

  it('handles quoted cells with commas and escaped quotes', () => {
    const { rows } = parseCsvBuffer(buf('name,note\n"O\'Hara, John","says ""hi"""\n'));
    expect(rows[0]).toEqual({ name: "O'Hara, John", note: 'says "hi"' });
  });

  it('handles quoted cells with embedded newlines', () => {
    const { rows } = parseCsvBuffer(buf('a,b\n"1\n2",3\n'));
    expect(rows[0]).toEqual({ a: '1\n2', b: '3' });
  });

  it('strips a UTF-8 BOM', () => {
    const { headers } = parseCsvBuffer(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf('a,b\n1,2\n')]));
    expect(headers).toEqual(['a', 'b']);
  });

  it('drops trailing blank lines', () => {
    const { rows } = parseCsvBuffer(buf('a\n1\n\n\n'));
    expect(rows).toEqual([{ a: '1' }]);
  });

  it('rejects unterminated quoted field', () => {
    expect(() => parseCsvBuffer(buf('a\n"unclosed'))).toThrowError(CsvParseError);
  });

  it('rejects duplicate headers', () => {
    expect(() => parseCsvBuffer(buf('a,a\n1,2\n'))).toThrowError(/duplicate header/);
  });

  it('rejects empty header cell', () => {
    expect(() => parseCsvBuffer(buf('a,,c\n1,2,3\n'))).toThrowError(/empty header/);
  });

  it('rejects rows with cell count != header count', () => {
    expect(() => parseCsvBuffer(buf('a,b,c\n1,2\n'))).toThrowError(/header has 3/);
  });

  it('rejects empty file', () => {
    expect(() => parseCsvBuffer(buf(''))).toThrowError(/empty file/);
  });
});
