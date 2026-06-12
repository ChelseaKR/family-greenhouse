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
