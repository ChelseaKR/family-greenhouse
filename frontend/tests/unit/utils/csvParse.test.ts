import { describe, it, expect } from 'vitest';
import { parseCsv, parseCsvObjects, unescapeFormulaGuard, toCsv } from '../../../src/utils/csv';

describe('parseCsv (RFC 4180)', () => {
  it('parses simple rows', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('parses quoted fields containing commas', () => {
    expect(parseCsv('"a,b",c')).toEqual([['a,b', 'c']]);
  });

  it('unescapes doubled quotes inside quoted fields', () => {
    expect(parseCsv('"say ""hi""",x')).toEqual([['say "hi"', 'x']]);
  });

  it('keeps embedded newlines inside quoted fields', () => {
    expect(parseCsv('"line1\nline2",b\nc,d')).toEqual([
      ['line1\nline2', 'b'],
      ['c', 'd'],
    ]);
  });

  it('handles CRLF row separators', () => {
    expect(parseCsv('a,b\r\nc,d\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('keeps CRs inside quoted fields', () => {
    expect(parseCsv('"a\r\nb",c')).toEqual([['a\r\nb', 'c']]);
  });

  it('handles empty fields and a trailing newline', () => {
    expect(parseCsv('a,,c\n,,\n')).toEqual([
      ['a', '', 'c'],
      ['', '', ''],
    ]);
  });

  it('flushes the last row when the file does not end with a newline', () => {
    expect(parseCsv('a,b\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('round-trips the output of toCsv (modulo the formula guard)', () => {
    const out = toCsv(
      ['name', 'notes'],
      [
        ['Pothos, the first', 'likes "bright" light\nand humidity'],
        ['Fern', ''],
      ]
    );
    expect(parseCsv(out)).toEqual([
      ['name', 'notes'],
      ['Pothos, the first', 'likes "bright" light\nand humidity'],
      ['Fern', ''],
    ]);
  });
});

describe('parseCsvObjects', () => {
  it('maps rows onto trimmed, lowercased headers', () => {
    const { headers, rows } = parseCsvObjects('Name, Species \nPothos,Epipremnum');
    expect(headers).toEqual(['name', 'species']);
    expect(rows).toEqual([{ name: 'Pothos', species: 'Epipremnum' }]);
  });

  it('tolerates extra columns and keeps them under their own keys', () => {
    const { rows } = parseCsvObjects('id,name,wateringGod\n1,Pothos,Chac');
    expect(rows[0]).toEqual({ id: '1', name: 'Pothos', wateringgod: 'Chac' });
  });

  it('omits keys for short rows instead of throwing', () => {
    const { rows } = parseCsvObjects('name,species,location\nPothos');
    expect(rows[0]).toEqual({ name: 'Pothos' });
  });

  it('drops fully blank rows', () => {
    const { rows } = parseCsvObjects('name\nPothos\n\n  \nFern\n');
    expect(rows.map((r) => r.name)).toEqual(['Pothos', 'Fern']);
  });

  it('returns empty for an empty file', () => {
    expect(parseCsvObjects('')).toEqual({ headers: [], rows: [] });
  });
});

describe('unescapeFormulaGuard', () => {
  it('strips the guard apostrophe our export adds before formula triggers', () => {
    expect(unescapeFormulaGuard("'=SUM(A1:A9)")).toBe('=SUM(A1:A9)');
    expect(unescapeFormulaGuard("'-5 leaves")).toBe('-5 leaves');
    expect(unescapeFormulaGuard("'+ok")).toBe('+ok');
    expect(unescapeFormulaGuard("'@home")).toBe('@home');
  });

  it('leaves genuine apostrophes and plain values alone', () => {
    expect(unescapeFormulaGuard("'tis a fern")).toBe("'tis a fern");
    expect(unescapeFormulaGuard('Monstera')).toBe('Monstera');
    expect(unescapeFormulaGuard('')).toBe('');
  });
});
