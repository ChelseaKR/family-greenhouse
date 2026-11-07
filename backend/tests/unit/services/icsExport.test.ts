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
    const ics = buildIcs([task({ nextDue: '2026-04-26T00:00:00Z' })], now);
    expect(ics).toMatch(/DTSTART;VALUE=DATE:20260426/);
    expect(ics).not.toMatch(/DTSTART[^\r\n]*T\d{6}/);
  });

  describe("all-day dates are the reader's local day, not the UTC day", () => {
    /** The DTSTART date a single task lands on, read in `zone`. */
    function dueDate(nextDue: string, zone?: string): string | undefined {
      const ics = buildIcs([task({ nextDue })], now, null, zone);
      return ics.match(/DTSTART;VALUE=DATE:(\d{8})/)?.[1];
    }

    it('is the ORIGINAL bug: UTC midnight on the 26th is still the 25th in the US', () => {
      // 2026-04-26T00:00Z is 8 p.m. on April 25 in New York (EDT, -4) and
      // 5 p.m. on April 25 in Los Angeles (PDT, -7). The feed used to say 26.
      expect(dueDate('2026-04-26T00:00:00Z', 'America/New_York')).toBe('20260425');
      expect(dueDate('2026-04-26T00:00:00Z', 'America/Los_Angeles')).toBe('20260425');
    });

    it('a new task due at the end of the local day stays on that day', () => {
      // `firstDueIso` sets 23:59 local: 23:59 PDT on April 25 is 06:59Z on the 26th.
      expect(dueDate('2026-04-26T06:59:00Z', 'America/Los_Angeles')).toBe('20260425');
      // The same instant is already the 26th in UTC and in Tokyo.
      expect(dueDate('2026-04-26T06:59:00Z', 'UTC')).toBe('20260426');
      expect(dueDate('2026-04-26T06:59:00Z', 'Asia/Tokyo')).toBe('20260426');
    });

    it('stays on the right day across the spring-forward DST change', () => {
      // US DST began 2026-03-08 at 2 a.m. local. 23:59 EST on March 7 is
      // 04:59Z on the 8th; 23:59 EDT on March 8 is 03:59Z on the 9th.
      expect(dueDate('2026-03-08T04:59:00Z', 'America/New_York')).toBe('20260307');
      expect(dueDate('2026-03-09T03:59:00Z', 'America/New_York')).toBe('20260308');
      // Just after local midnight on each side of the change.
      expect(dueDate('2026-03-08T05:00:00Z', 'America/New_York')).toBe('20260308');
      expect(dueDate('2026-03-09T04:00:00Z', 'America/New_York')).toBe('20260309');
    });

    it('stays on the right day across the fall-back DST change', () => {
      // US DST ended 2026-11-01 at 2 a.m. local. 23:59 PDT on Oct 31 is
      // 06:59Z on Nov 1; 23:59 PST on Nov 1 is 07:59Z on Nov 2.
      expect(dueDate('2026-11-01T06:59:00Z', 'America/Los_Angeles')).toBe('20261031');
      expect(dueDate('2026-11-02T07:59:00Z', 'America/Los_Angeles')).toBe('20261101');
      expect(dueDate('2026-11-02T08:00:00Z', 'America/Los_Angeles')).toBe('20261102');
    });

    it('falls back to the UTC day when no zone, or an unknown one, is given', () => {
      expect(dueDate('2026-04-26T00:00:00Z')).toBe('20260426');
      expect(dueDate('2026-04-26T00:00:00Z', '')).toBe('20260426');
      expect(dueDate('2026-04-26T00:00:00Z', 'Not/AZone')).toBe('20260426');
    });

    it('leaves out a task whose due date cannot be read instead of printing NaN', () => {
      const ics = buildIcs(
        [task({ id: 'bad', nextDue: 'not-a-date' }), task({ id: 'good' })],
        now,
        null,
        'America/New_York'
      );
      expect(ics).not.toMatch(/NaN/);
      expect(ics).not.toMatch(/UID:bad@/);
      expect(ics).toMatch(/UID:good@familygreenhouse\.app/);
    });

    it('keeps DTSTAMP a UTC instant whatever the reader zone', () => {
      const ics = buildIcs([task()], now, null, 'America/New_York');
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

  it('escapes commas, semicolons, and newlines in free text', () => {
    const ics = buildIcs([task({ type: 'custom', customType: 'mist, gently; not\nover' })], now);
    // Each special char gets a backslash prefix.
    expect(ics).toMatch(/\\,/);
    expect(ics).toMatch(/\\;/);
    expect(ics).toMatch(/\\n/);
  });

  it('emits titles, cadence, and dates only — never task notes or the assignee name', () => {
    // The subscription URL is a capability URL (services/calendarTokens.ts):
    // whoever holds it can read the feed, so a leaked link must not reveal
    // the household's private notes or which member a task is assigned to.
    const ics = buildIcs(
      [
        task({
          notes: 'spare key is under the blue pot',
          assignedTo: 'user-2',
          assignedToName: 'Mel Member',
        }),
      ],
      now
    );
    expect(ics).toMatch(/SUMMARY:Water — Monstera/);
    expect(ics).toMatch(/DESCRIPTION:Recurring every 7 days\./);
    expect(ics).not.toContain('spare key');
    expect(ics).not.toContain('Mel Member');
    expect(ics).not.toContain('Assigned to');
    expect(ics).not.toContain('user-2');
  });

  it('uses the customType label when present', () => {
    const ics = buildIcs([task({ type: 'custom', customType: 'Misting' })], now);
    expect(ics).toMatch(/SUMMARY:Misting — Monstera/);
  });

  it('folds long lines (>75 octets) per RFC 5545', () => {
    const long = 'a'.repeat(200);
    const ics = buildIcs([task({ plantName: long })], now);
    // Folded continuation lines start with a single space.
    expect(/\r\n /.test(ics)).toBe(true);
  });

  it('folds a line whose UTF-8 byte length exceeds 75 even when its UTF-16 code-unit length does not', () => {
    // 72 UTF-16 code units but 164 UTF-8 bytes (CJK + accented text) — a
    // line `String.length` alone reports as "under 75" while RFC 5545's
    // actual octet limit is blown more than 2x over.
    const plantName = '日本語植物名前がとても長いですかもしれません🌱café résumé naïve';
    expect(plantName.length).toBeLessThanOrEqual(75);
    expect(Buffer.byteLength(plantName, 'utf8')).toBeGreaterThan(75);

    const ics = buildIcs([task({ plantName, type: 'custom', customType: '水やり' })], now);
    const lines = ics.split('\r\n');
    const summaryStart = lines.findIndex((l) => l.startsWith('SUMMARY:'));
    expect(summaryStart).toBeGreaterThanOrEqual(0);

    // Every physical line — the SUMMARY line itself and any continuation —
    // must be <=75 UTF-8 octets, per RFC 5545.
    let i = summaryStart;
    let raw = lines[i];
    while (lines[i + 1]?.startsWith(' ')) {
      i += 1;
      raw += '\r\n' + lines[i];
    }
    for (const physicalLine of raw.split('\r\n')) {
      expect(Buffer.byteLength(physicalLine, 'utf8')).toBeLessThanOrEqual(75);
    }
    // Unfolding (strip CRLF + the single leading space) must reproduce the
    // original text exactly — no character was corrupted at a fold point.
    const unfolded = raw
      .split('\r\n')
      .map((l, idx) => (idx === 0 ? l : l.slice(1)))
      .join('');
    expect(unfolded).toBe(`SUMMARY:水やり — ${plantName}`);
  });

  it('never splits a surrogate pair (emoji) across a fold boundary', () => {
    // An astral character (2 UTF-16 code units) landing exactly on a fold
    // boundary must move whole to the next line, not be bisected into an
    // unpaired surrogate.
    const plantName = 'x'.repeat(73) + '🌱' + 'y'.repeat(20);
    const ics = buildIcs([task({ plantName })], now);
    // A lone surrogate serializes as the U+FFFD replacement character (or
    // throws) — neither of which can appear here if the pair stayed intact.
    expect(ics).not.toMatch(/�/);
    expect(ics).toContain('🌱');
  });
});
