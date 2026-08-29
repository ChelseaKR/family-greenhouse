import { describe, expect, it } from 'vitest';
import { buildIcs } from '../../../src/services/icsExport.js';
import type { Task } from '../../../src/models/types.js';

const now = new Date('2026-04-25T12:00:00Z');

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    householdId: 'hh',
    plantId: 'p1',
    plantName: 'Monstera',
    type: 'water',
    customType: undefined,
    frequency: 7,
    nextDue: '2026-04-26T00:00:00Z',
    lastCompleted: null,
    assignedTo: null,
    assignedToName: null,
    notes: null,
    createdBy: 'u',
    createdAt: '2026-04-01T00:00:00Z',
    ...overrides,
  };
}

describe('buildIcs', () => {
  it('emits a VCALENDAR with VERSION + PRODID', () => {
    const ics = buildIcs([], now);
    expect(ics).toMatch(/BEGIN:VCALENDAR/);
    expect(ics).toMatch(/VERSION:2\.0/);
    expect(ics).toMatch(/PRODID:.*Family Greenhouse/);
    expect(ics).toMatch(/END:VCALENDAR/);
  });

  it('uses CRLF line endings (RFC 5545)', () => {
    const ics = buildIcs([task()], now);
    expect(ics.includes('\r\n')).toBe(true);
    // No bare LFs that aren't preceded by CR.
    const bareLfs = ics.match(/(?<!\r)\n/g) ?? [];
    expect(bareLfs.length).toBe(0);
  });

  it('writes one VEVENT per task with stable UID', () => {
    const ics = buildIcs([task({ id: 'abc' })], now);
    expect(ics).toMatch(/BEGIN:VEVENT/);
    expect(ics).toMatch(/UID:abc@familygreenhouse\.app/);
    expect(ics).toMatch(/END:VEVENT/);
  });

  it('emits an all-day DTSTART (no time of day)', () => {
    // Zone stated explicitly. This assertion used to rely on the implicit UTC
    // reading of `nextDue`, which made it a statement about the
    // implementation rather than about a user: `2026-04-26T00:00:00Z` is
    // Apr 25, 20:00 in America/New_York, so `20260426` is the RIGHT answer
    // only for a recipient in UTC. Naming the zone is what makes the
    // expectation checkable (#342 item 3).
    const ics = buildIcs([task({ nextDue: '2026-04-26T00:00:00Z' })], now, 'UTC');
    expect(ics).toMatch(/DTSTART;VALUE=DATE:20260426/);
  });

  describe("DTSTART is the recipient's calendar day, not UTC's (#342 item 3)", () => {
    // `DTSTART;VALUE=DATE` is a floating date: it names a calendar day and
    // every client shows exactly that day. The only correct value is the day
    // the app itself calls the task due.
    it('resolves an evening-UTC instant to the previous day west of UTC', () => {
      // 2026-06-09T00:00:00Z is Mon Jun 8, 20:00 EDT. The task list says
      // "Mon, Jun 8"; the feed must not say Tue Jun 9.
      const ics = buildIcs([task({ nextDue: '2026-06-09T00:00:00Z' })], now, 'America/New_York');
      expect(ics).toMatch(/DTSTART;VALUE=DATE:20260608/);
      expect(ics).not.toMatch(/DTSTART;VALUE=DATE:20260609/);
    });

    it('resolves a morning-UTC instant to the next day east of UTC', () => {
      // 2026-06-08T22:00:00Z is Tue Jun 9, 08:00 in Australia/Sydney.
      const ics = buildIcs([task({ nextDue: '2026-06-08T22:00:00Z' })], now, 'Australia/Sydney');
      expect(ics).toMatch(/DTSTART;VALUE=DATE:20260609/);
    });

    it('keeps the UTC reading when the recipient is in UTC', () => {
      const ics = buildIcs([task({ nextDue: '2026-06-09T00:00:00Z' })], now, 'UTC');
      expect(ics).toMatch(/DTSTART;VALUE=DATE:20260609/);
    });

    it("honours the DST offset in effect at the due instant, not today's", () => {
      // 2026-01-15T02:00:00Z is Jan 14, 21:00 EST (UTC-5). Using the summer
      // offset would land on Jan 15.
      const ics = buildIcs([task({ nextDue: '2026-01-15T02:00:00Z' })], now, 'America/New_York');
      expect(ics).toMatch(/DTSTART;VALUE=DATE:20260114/);
    });

    it('falls back to UTC on an unrecognized zone instead of throwing', () => {
      // The zone comes from stored user preferences; a bad value must not
      // 500 the whole feed.
      expect(() =>
        buildIcs([task({ nextDue: '2026-06-09T00:00:00Z' })], now, 'Not/AZone')
      ).not.toThrow();
      const ics = buildIcs([task({ nextDue: '2026-06-09T00:00:00Z' })], now, 'Not/AZone');
      expect(ics).toMatch(/DTSTART;VALUE=DATE:20260609/);
    });

    it('leaves DTSTAMP in UTC, which is what RFC 5545 requires of it', () => {
      const ics = buildIcs([task()], new Date('2026-04-25T12:00:00Z'), 'America/New_York');
      expect(ics).toMatch(/DTSTAMP:20260425T120000Z/);
    });
  });

  it('emits a single occurrence at nextDue — no RRULE (re-anchored server-side)', () => {
    // An RRULE anchored at export-time DTSTART drifts from the app's
    // re-anchored nextDue after the first completion; the feed now emits one
    // occurrence and relies on calendar subscription refresh instead.
    const ics = buildIcs([task({ frequency: 3 })], now);
    expect(ics).not.toMatch(/RRULE/);
    expect(ics).toMatch(/DTSTART;VALUE=DATE:20260426/);
  });

  it('renders legacy rows with an empty type as "Care task" instead of throwing', () => {
    const ics = buildIcs([task({ type: '' as never })], now);
    expect(ics).toMatch(/SUMMARY:Care task — Monstera/);
  });

  it('escapes commas, semicolons, and newlines in description', () => {
    const ics = buildIcs([task({ notes: 'mist, gently; not\nover' })], now);
    // Each special char gets a backslash prefix.
    expect(ics).toMatch(/\\,/);
    expect(ics).toMatch(/\\;/);
    expect(ics).toMatch(/\\n/);
  });

  it('uses the customType label when present', () => {
    const ics = buildIcs([task({ type: 'custom', customType: 'Misting' })], now);
    expect(ics).toMatch(/SUMMARY:Misting — Monstera/);
  });

  it('folds long lines (>75 octets) per RFC 5545', () => {
    const long = 'a'.repeat(200);
    const ics = buildIcs([task({ notes: long })], now);
    // Folded continuation lines start with a single space.
    expect(/\r\n /.test(ics)).toBe(true);
  });
});
