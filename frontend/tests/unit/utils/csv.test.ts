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
