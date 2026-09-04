/**
 * The proof-of-visit report is an artefact a household hands to someone who is
 * paying, so its arithmetic has to be defensible. These tests pin the two
 * honesty rules the builder exists to enforce: totals come from the exact
 * counters rather than the (capped) detail arrays, and a visit whose detail is
 * incomplete says so instead of presenting the short list as the whole story.
 */
import { describe, it, expect } from 'vitest';
import { buildCaretakerReport, resolveReportRange } from '../../../src/services/caretakerReport.js';
import type { CaretakerVisit } from '../../../src/services/caretakerService.js';

function visit(overrides: Partial<CaretakerVisit> = {}): CaretakerVisit {
  return {
    id: 'v1',
    householdId: 'hh',
    caretakerId: 'seat-1',
    caretakerName: 'Dana',
    startedAt: '2026-09-03T09:00:00.000Z',
    lastActionAt: '2026-09-03T09:45:00.000Z',
    tasksCompleted: [],
    photos: [],
    notes: [],
    taskCount: 0,
    photoCount: 0,
    noteCount: 0,
    ...overrides,
  };
}

const task = (taskId: string) => ({
  taskId,
  plantId: 'p1',
  plantName: 'Monstera',
  taskType: 'water',
  at: '2026-09-03T09:05:00.000Z',
});

describe('buildCaretakerReport', () => {
  it('totals from the counters, not from the stored detail', async () => {
    // The visit did 120 tasks; the row could only keep 2 of them.
    const report = buildCaretakerReport({
      householdId: 'hh',
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-30T23:59:59.999Z',
      generatedAt: '2026-10-01T00:00:00.000Z',
      visits: [visit({ tasksCompleted: [task('t1'), task('t2')], taskCount: 120 })],
    });

    expect(report.totals.tasksCompleted).toBe(120);
    expect(report.visits[0].tasksCompleted).toHaveLength(2);
    expect(report.visits[0].omitted.tasks).toBe(118);
    expect(report.visits[0].detailTruncated).toBe(true);
  });

  it('reports no omissions when the detail is complete', () => {
    const report = buildCaretakerReport({
      householdId: 'hh',
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-30T23:59:59.999Z',
      generatedAt: '2026-10-01T00:00:00.000Z',
      visits: [visit({ tasksCompleted: [task('t1')], taskCount: 1 })],
    });
    expect(report.visits[0].detailTruncated).toBe(false);
    expect(report.visits[0].omitted).toEqual({ tasks: 0, photos: 0, notes: 0 });
  });

  it('never reports a negative omission if a counter lags its array', () => {
    const report = buildCaretakerReport({
      householdId: 'hh',
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-30T23:59:59.999Z',
      generatedAt: '2026-10-01T00:00:00.000Z',
      visits: [visit({ tasksCompleted: [task('t1'), task('t2')], taskCount: 1 })],
    });
    expect(report.visits[0].omitted.tasks).toBe(0);
    expect(report.visits[0].detailTruncated).toBe(false);
  });

  it('groups by caretaker, keeping each one’s first and last visit', () => {
    const report = buildCaretakerReport({
      householdId: 'hh',
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-30T23:59:59.999Z',
      generatedAt: '2026-10-01T00:00:00.000Z',
      visits: [
        visit({ id: 'v2', startedAt: '2026-09-10T09:00:00.000Z', taskCount: 3 }),
        visit({ id: 'v1', startedAt: '2026-09-03T09:00:00.000Z', taskCount: 2 }),
        visit({
          id: 'v3',
          caretakerId: 'seat-2',
          caretakerName: 'Alex',
          startedAt: '2026-09-05T09:00:00.000Z',
          noteCount: 1,
        }),
      ],
    });

    // Visits come back oldest-first regardless of the order they were read in.
    expect(report.visits.map((v) => v.id)).toEqual(['v1', 'v3', 'v2']);
    expect(report.totals).toEqual({
      visits: 3,
      tasksCompleted: 5,
      photos: 0,
      notes: 1,
      caretakers: 2,
    });

    const dana = report.byCaretaker.find((row) => row.caretakerId === 'seat-1')!;
    expect(dana.visits).toBe(2);
    expect(dana.tasksCompleted).toBe(5);
    expect(dana.firstVisitAt).toBe('2026-09-03T09:00:00.000Z');
  });

  it('describes an empty range as empty — and says nothing more', () => {
    const report = buildCaretakerReport({
      householdId: 'hh',
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-30T23:59:59.999Z',
      generatedAt: '2026-10-01T00:00:00.000Z',
      visits: [],
    });
    expect(report.visits).toEqual([]);
    expect(report.totals.visits).toBe(0);
    expect(report.byCaretaker).toEqual([]);
  });
});

describe('resolveReportRange', () => {
  it('widens calendar dates to whole days', () => {
    expect(resolveReportRange('2026-09-01', '2026-09-30')).toEqual({
      fromIso: '2026-09-01T00:00:00.000Z',
      toIso: '2026-09-30T23:59:59.999Z',
    });
  });

  it('passes ISO instants through', () => {
    const range = resolveReportRange('2026-09-01T06:00:00.000Z', '2026-09-02T06:00:00.000Z');
    expect(range).toEqual({
      fromIso: '2026-09-01T06:00:00.000Z',
      toIso: '2026-09-02T06:00:00.000Z',
    });
  });

  it('refuses an inverted or unparseable range rather than guessing', () => {
    // Guessing a window would produce a confident report for the wrong dates,
    // which is worse than a 400.
    expect(resolveReportRange('2026-09-30', '2026-09-01')).toBeNull();
    expect(resolveReportRange('not-a-date', '2026-09-01')).toBeNull();
    expect(resolveReportRange('2026-09-01', 'not-a-date')).toBeNull();
  });

  it('accepts a single-day range', () => {
    const range = resolveReportRange('2026-09-03', '2026-09-03');
    expect(range?.fromIso).toBe('2026-09-03T00:00:00.000Z');
    expect(range?.toIso).toBe('2026-09-03T23:59:59.999Z');
  });

  // A repeated `?from=a&from=b` arrives as an array on Express. An array of
  // ten characters would otherwise take the calendar-date branch and be
  // template-stringified into a plausible-looking but wrong instant, so the
  // range must be refused on type rather than parsed on length.
  it('refuses a non-string range instead of branching on its length', () => {
    expect(resolveReportRange(['2026-09-01', '2026-09-02'], '2026-09-30')).toBeNull();
    expect(resolveReportRange('2026-09-01', ['2026-09-30', '2026-10-01'])).toBeNull();
    expect(resolveReportRange('2026-09-01'.split(''), '2026-09-30')).toBeNull();
    expect(resolveReportRange(undefined, '2026-09-30')).toBeNull();
    expect(resolveReportRange(1_756_000_000_000, '2026-09-30')).toBeNull();
  });
});
