import { describe, expect, it } from 'vitest';
import { buildRecurringAllDayIcs, escapeIcsText, foldIcsLine } from '@/lib/ics';

const EVENT = {
  uid: 'care-zz-plant@familygreenhouse.net',
  start: { year: 2026, month: 12, day: 31 },
  intervalDays: 14,
  summary: 'Check the soil: ZZ plant',
  description:
    'Check the soil; if dry, water, then wait.\nhttps://familygreenhouse.net/care/zz-plant',
  url: 'https://familygreenhouse.net/care/zz-plant',
  now: new Date(Date.UTC(2026, 11, 2, 18, 5, 9)),
};

/** Unfold RFC 5545 continuation lines back into whole content lines. */
const unfold = (ics: string) => ics.replace(/\r\n /g, '').split('\r\n');

describe('buildRecurringAllDayIcs', () => {
  it('writes one recurring all-day event with CRLF line endings', () => {
    const ics = buildRecurringAllDayIcs(EVENT);
    expect(ics.endsWith('\r\n')).toBe(true);
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    const lines = unfold(ics);
    expect(lines[0]).toBe('BEGIN:VCALENDAR');
    expect(lines).toContain('VERSION:2.0');
    expect(lines).toContain('UID:care-zz-plant@familygreenhouse.net');
    expect(lines).toContain('DTSTAMP:20261202T180509Z');
    expect(lines).toContain('DTSTART;VALUE=DATE:20261231');
    // The day after, across a year boundary.
    expect(lines).toContain('DTEND;VALUE=DATE:20270101');
    expect(lines).toContain('RRULE:FREQ=DAILY;INTERVAL=14');
    expect(lines).toContain('SUMMARY:Check the soil: ZZ plant');
    expect(lines).toContain('URL:https://familygreenhouse.net/care/zz-plant');
    expect(lines).toContain(
      'DESCRIPTION:Check the soil\\; if dry\\, water\\, then wait.\\nhttps://familygreenhouse.net/care/zz-plant'
    );
    expect(lines.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(1);
    expect(lines.at(-2)).toBe('END:VCALENDAR');
  });

  it('keeps every physical line within 75 octets', () => {
    const ics = buildRecurringAllDayIcs({
      ...EVENT,
      description: 'Check the soil of your Chinese money plant. '.repeat(10) + 'é’“”'.repeat(30),
    });
    const encoder = new TextEncoder();
    for (const line of ics.split('\r\n')) {
      expect(encoder.encode(line).length, line).toBeLessThanOrEqual(75);
    }
  });

  it('refuses an interval that is not a whole number of days', () => {
    for (const intervalDays of [0, -7, 3.5, Number.NaN]) {
      expect(() => buildRecurringAllDayIcs({ ...EVENT, intervalDays })).toThrow(RangeError);
    }
  });
});

describe('ics text helpers', () => {
  it('escapes backslashes, separators and line breaks', () => {
    expect(escapeIcsText('a\\b;c,d\ne\r\nf')).toBe('a\\\\b\\;c\\,d\\ne\\nf');
  });

  it('never splits a multi-byte character when folding', () => {
    const folded = foldIcsLine(`DESCRIPTION:${'’'.repeat(40)}`);
    expect(folded.replace(/\r\n /g, '')).toBe(`DESCRIPTION:${'’'.repeat(40)}`);
    for (const part of folded.split('\r\n')) {
      expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75);
    }
  });
});
