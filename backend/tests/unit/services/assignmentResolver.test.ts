import { describe, expect, it } from 'vitest';
import type { Task } from '../../../src/models/types.js';
import {
  isAwayAt,
  isEscalatedOccurrence,
  isExplicitAssignment,
  resolveAssignment,
  vacationAt,
  type AssignmentContext,
  type VacationRef,
} from '../../../src/services/assignmentResolver.js';

const NOW = new Date('2026-06-10T12:00:00.000Z');

const members = [
  { userId: 'sam', name: 'Sam' },
  { userId: 'priya', name: 'Priya' },
  { userId: 'lee', name: 'Lee' },
];

function window(
  userId: string,
  coveredBy: string,
  startDate: string,
  endDate: string,
  coveredByName: string | null = null
): VacationRef {
  return { userId, coveredBy, coveredByName, startDate, endDate };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    householdId: 'hh',
    plantId: 'p1',
    plantName: 'Monstera',
    type: 'water',
    customType: null,
    frequency: 7,
    lastCompleted: null,
    nextDue: '2026-06-09T00:00:00.000Z',
    assignedTo: null,
    assignedToName: null,
    assignmentSource: null,
    notes: null,
    createdBy: 'sam',
    createdAt: '2026-05-01T00:00:00.000Z',
    ...overrides,
  };
}

function ctx(vacations: VacationRef[] = []): AssignmentContext {
  return { members, vacations };
}

describe('assignmentResolver — vacation predicates', () => {
  it('finds the window that has a member away at an instant, inclusive of both ends', () => {
    const w = window('sam', 'priya', '2026-06-10T00:00:00.000Z', '2026-06-12T00:00:00.000Z');
    expect(vacationAt([w], 'sam', NOW)).toBe(w);
    expect(vacationAt([w], 'sam', new Date('2026-06-10T00:00:00.000Z'))).toBe(w);
    expect(vacationAt([w], 'sam', new Date('2026-06-12T00:00:00.000Z'))).toBe(w);
    expect(vacationAt([w], 'sam', new Date('2026-06-12T00:00:00.001Z'))).toBeNull();
    expect(vacationAt([w], 'priya', NOW)).toBeNull();
  });

  it('treats an upcoming window as "away" only once it starts', () => {
    const later = window('sam', 'priya', '2026-06-20T00:00:00.000Z', '2026-06-25T00:00:00.000Z');
    expect(isAwayAt([later], 'sam', NOW)).toBe(false);
    expect(isAwayAt([later], 'sam', new Date('2026-06-21T00:00:00.000Z'))).toBe(true);
  });
});

describe('assignmentResolver — classification', () => {
  it('an explicit assignment is assignedTo with a null source', () => {
    expect(isExplicitAssignment(task({ assignedTo: 'sam' }))).toBe(true);
    expect(
      isExplicitAssignment(task({ assignedTo: 'sam', assignmentSource: 'space_default' }))
    ).toBe(false);
    expect(isExplicitAssignment(task())).toBe(false);
  });

  it('an escalated occurrence is unassigned with escalatedForDue pinned to the current nextDue', () => {
    const due = '2026-06-09T00:00:00.000Z';
    expect(isEscalatedOccurrence(task({ nextDue: due, escalatedForDue: due }))).toBe(true);
    // A completion advanced nextDue: the marker is stale, the rule is re-armed.
    expect(
      isEscalatedOccurrence(task({ nextDue: '2026-06-16T00:00:00.000Z', escalatedForDue: due }))
    ).toBe(false);
    // Claimed after escalation: no longer up for grabs.
    expect(
      isEscalatedOccurrence(task({ nextDue: due, escalatedForDue: due, assignedTo: 'lee' }))
    ).toBe(false);
  });
});

describe('assignmentResolver — resolveAssignment precedence', () => {
  it('explicit assignment resolves to the holder, untouched', () => {
    const resolved = resolveAssignment(
      task({ assignedTo: 'sam', assignedToName: 'Sam' }),
      ctx(),
      NOW
    );
    expect(resolved).toMatchObject({
      userId: 'sam',
      name: 'Sam',
      source: 'explicit',
      effectiveUserId: 'sam',
      coveringFor: null,
    });
  });

  it('a space-inherited assignment is reported as such (claimable)', () => {
    const resolved = resolveAssignment(
      task({ assignedTo: 'priya', assignedToName: 'Priya', assignmentSource: 'space_default' }),
      ctx(),
      NOW
    );
    expect(resolved.source).toBe('space_default');
    expect(resolved.userId).toBe('priya');
  });

  it('an escalated, unclaimed occurrence resolves to nobody with source "escalated"', () => {
    const due = '2026-06-01T00:00:00.000Z';
    const resolved = resolveAssignment(task({ nextDue: due, escalatedForDue: due }), ctx(), NOW);
    expect(resolved).toMatchObject({ userId: null, source: 'escalated', effectiveUserId: null });
  });

  it('a departed member resolves to unassigned rather than to an unreachable name', () => {
    const resolved = resolveAssignment(
      task({ assignedTo: 'gone', assignedToName: 'Gone' }),
      ctx(),
      NOW
    );
    expect(resolved).toMatchObject({ userId: null, name: null, source: 'unassigned' });
  });

  it('escalation + vacation: an away holder with a reachable cover is delivered to the cover', () => {
    const vacations = [
      window('sam', 'priya', '2026-06-08T00:00:00.000Z', '2026-06-15T00:00:00.000Z', 'Priya'),
    ];
    const resolved = resolveAssignment(
      task({ assignedTo: 'sam', assignedToName: 'Sam' }),
      ctx(vacations),
      NOW
    );
    expect(resolved).toMatchObject({
      userId: 'sam',
      source: 'explicit',
      effectiveUserId: 'priya',
      effectiveName: 'Priya',
      coveringFor: 'Sam',
    });
  });

  it('leaves no cover when the cover is themselves away, or has left the household', () => {
    const coverAway = [
      window('sam', 'priya', '2026-06-08T00:00:00.000Z', '2026-06-15T00:00:00.000Z'),
      window('priya', 'lee', '2026-06-09T00:00:00.000Z', '2026-06-11T00:00:00.000Z'),
    ];
    expect(
      resolveAssignment(task({ assignedTo: 'sam', assignedToName: 'Sam' }), ctx(coverAway), NOW)
    ).toMatchObject({ effectiveUserId: 'sam', coveringFor: null });

    const coverGone = [
      window('sam', 'gone', '2026-06-08T00:00:00.000Z', '2026-06-15T00:00:00.000Z'),
    ];
    expect(
      resolveAssignment(task({ assignedTo: 'sam', assignedToName: 'Sam' }), ctx(coverGone), NOW)
    ).toMatchObject({ effectiveUserId: 'sam', coveringFor: null });
  });

  it('a window that has not started yet does not re-route', () => {
    const upcoming = [
      window('sam', 'priya', '2026-06-20T00:00:00.000Z', '2026-06-25T00:00:00.000Z'),
    ];
    expect(
      resolveAssignment(task({ assignedTo: 'sam', assignedToName: 'Sam' }), ctx(upcoming), NOW)
    ).toMatchObject({ effectiveUserId: 'sam', coveringFor: null });
  });
});
