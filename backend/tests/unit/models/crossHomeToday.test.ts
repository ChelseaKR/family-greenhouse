import { describe, expect, it } from 'vitest';
import {
  InvalidUntilError,
  isDueBy,
  resolveCutoff,
  UNTIL_WINDOW_MS,
} from '../../../src/models/crossHomeToday.js';

const NOW = new Date('2026-09-03T15:30:00.000Z');

describe('resolveCutoff', () => {
  it('defaults to the end of the UTC day when the client sends nothing', () => {
    expect(resolveCutoff(undefined, NOW)).toBe('2026-09-03T23:59:59.999Z');
    expect(resolveCutoff('', NOW)).toBe('2026-09-03T23:59:59.999Z');
  });

  it("accepts the caller's own end-of-day and echoes it back normalised", () => {
    // 23:59:59.999 in UTC-8 is 07:59:59.999Z the next day — a real "today"
    // for that caller, which the end-of-UTC-day default would have cut short.
    expect(resolveCutoff('2026-09-03T23:59:59.999-08:00', NOW)).toBe('2026-09-04T07:59:59.999Z');
  });

  it('rejects garbage', () => {
    expect(() => resolveCutoff('next tuesday', NOW)).toThrow(InvalidUntilError);
    expect(() => resolveCutoff('next tuesday', NOW)).toThrow(/ISO-8601/);
  });

  it('rejects a cutoff outside ±48h of now — the parameter describes today, not the schedule', () => {
    const tooFar = new Date(NOW.getTime() + UNTIL_WINDOW_MS + 1).toISOString();
    expect(() => resolveCutoff(tooFar, NOW)).toThrow(InvalidUntilError);
    const tooEarly = new Date(NOW.getTime() - UNTIL_WINDOW_MS - 1).toISOString();
    expect(() => resolveCutoff(tooEarly, NOW)).toThrow(InvalidUntilError);
    const edge = new Date(NOW.getTime() + UNTIL_WINDOW_MS).toISOString();
    expect(resolveCutoff(edge, NOW)).toBe(edge);
  });
});

describe('isDueBy', () => {
  it('is inclusive of the cutoff instant and compares instants, not strings', () => {
    expect(isDueBy('2026-09-03T23:59:59.999Z', '2026-09-03T23:59:59.999Z')).toBe(true);
    expect(isDueBy('2026-09-04T00:00:00.000Z', '2026-09-03T23:59:59.999Z')).toBe(false);
    // Same instant in a different textual form — a string compare would
    // sort this one out of today.
    expect(isDueBy('2026-09-04T01:00:00+02:00', '2026-09-03T23:00:00.000Z')).toBe(true);
    // Overdue is always in.
    expect(isDueBy('2020-01-01T00:00:00.000Z', '2026-09-03T23:59:59.999Z')).toBe(true);
  });
});
