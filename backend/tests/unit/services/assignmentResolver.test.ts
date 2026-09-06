import { describe, expect, it } from 'vitest';
import type { Task } from '../../../src/models/types.js';
import {
  isAwayAt,
  resolveInheritedAssignee,
  rotationPeriodIndex,
  rotationTurnAt,
  isEscalatedOccurrence,
  isExplicitAssignment,
  resolveAssignment,
  vacationAt,
  type AssignmentContext,
  type VacationRef,
} from '../../../src/services/assignmentResolver.js';
import type { SpaceRotation } from '../../../src/models/types.js';

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

// ---------------------------------------------------------------------------
// Care rotation (ADR 0018)
// ---------------------------------------------------------------------------

const ANCHOR = '2026-06-01T00:00:00.000Z';

function rotation(over: Partial<SpaceRotation> = {}): SpaceRotation {
  return { memberIds: ['sam', 'priya'], cadence: 'weekly', anchor: ANCHOR, ...over };
}

const always = () => true;

describe('assignmentResolver — rotation period maths', () => {
  it('counts whole weeks from the anchor', () => {
    expect(rotationPeriodIndex(rotation(), new Date(ANCHOR))).toBe(0);
    expect(rotationPeriodIndex(rotation(), new Date('2026-06-07T23:59:00.000Z'))).toBe(0);
    expect(rotationPeriodIndex(rotation(), new Date('2026-06-08T00:00:00.000Z'))).toBe(1);
    expect(rotationPeriodIndex(rotation(), new Date('2026-06-29T00:00:00.000Z'))).toBe(4);
  });

  it('counts CALENDAR months, so month length never shifts a handover', () => {
    const monthly = rotation({ cadence: 'monthly' });
    expect(rotationPeriodIndex(monthly, new Date('2026-06-30T23:00:00.000Z'))).toBe(0);
    expect(rotationPeriodIndex(monthly, new Date('2026-07-01T00:00:00.000Z'))).toBe(1);
    // February is short; the March turn still starts on 1 March.
    expect(rotationPeriodIndex(monthly, new Date('2027-03-01T00:00:00.000Z'))).toBe(9);
  });

  it('handles dates before the anchor without throwing the order out', () => {
    const before = new Date('2026-05-25T00:00:00.000Z'); // period -1
    expect(rotationPeriodIndex(rotation(), before)).toBe(-1);
    // -1 mod 2 must land on the LAST member, not crash or return index -1.
    expect(rotationTurnAt(rotation(), before, always)).toBe('priya');
  });

  it('a malformed anchor degrades to period 0 rather than NaN', () => {
    expect(rotationPeriodIndex(rotation({ anchor: 'nonsense' }), new Date(ANCHOR))).toBe(0);
  });
});

describe('assignmentResolver — whose turn', () => {
  it('alternates in order, week by week', () => {
    expect(rotationTurnAt(rotation(), new Date(ANCHOR), always)).toBe('sam');
    expect(rotationTurnAt(rotation(), new Date('2026-06-08T00:00:00.000Z'), always)).toBe('priya');
    expect(rotationTurnAt(rotation(), new Date('2026-06-15T00:00:00.000Z'), always)).toBe('sam');
  });

  it('rotation + vacation: skips whoever is away and hands the turn onward', () => {
    const notSam = (id: string) => id !== 'sam';
    expect(rotationTurnAt(rotation(), new Date(ANCHOR), notSam)).toBe('priya');
  });

  it('returns null when nobody is eligible — never an arbitrary member', () => {
    expect(rotationTurnAt(rotation(), new Date(ANCHOR), () => false)).toBeNull();
    expect(rotationTurnAt(rotation({ memberIds: [] }), new Date(ANCHOR), always)).toBeNull();
  });
});

describe('assignmentResolver — what a new occurrence inherits', () => {
  const space = (
    over: Partial<{ defaultCaregiverId: string | null; rotation: SpaceRotation | null }> = {}
  ) => ({
    defaultCaregiverId: null,
    rotation: null,
    ...over,
  });

  it('rotation outranks the space default caregiver', () => {
    const inherited = resolveInheritedAssignee(
      space({ defaultCaregiverId: 'lee', rotation: rotation() }),
      ctx(),
      new Date(ANCHOR)
    );
    expect(inherited).toEqual({ userId: 'sam', name: 'Sam', source: 'rotation' });
  });

  it('falls back to the space default when there is no rotation', () => {
    expect(
      resolveInheritedAssignee(space({ defaultCaregiverId: 'lee' }), ctx(), new Date(ANCHOR))
    ).toEqual({ userId: 'lee', name: 'Lee', source: 'space_default' });
  });

  it('rotation + vacation: resolves for the OCCURRENCE date, not today', () => {
    // Priya's week, but Priya is away that week: the turn passes to Sam.
    const vacations = [
      window('priya', 'sam', '2026-06-08T00:00:00.000Z', '2026-06-14T00:00:00.000Z'),
    ];
    const priyasWeek = new Date('2026-06-09T00:00:00.000Z');
    expect(
      resolveInheritedAssignee(space({ rotation: rotation() }), ctx(vacations), priyasWeek)
    ).toEqual({ userId: 'sam', name: 'Sam', source: 'rotation' });
    // The same rotation, a week later, is Priya's again — the skip was not a
    // permanent handover.
    expect(
      resolveInheritedAssignee(
        space({ rotation: rotation() }),
        ctx(vacations),
        new Date('2026-06-22T00:00:00.000Z')
      )
    ).toEqual({ userId: 'priya', name: 'Priya', source: 'rotation' });
  });

  it('a rotation with everyone away leaves the task up for grabs, and does NOT fall back to the default', () => {
    const vacations = [
      window('sam', 'lee', '2026-05-30T00:00:00.000Z', '2026-06-30T00:00:00.000Z'),
      window('priya', 'lee', '2026-05-30T00:00:00.000Z', '2026-06-30T00:00:00.000Z'),
    ];
    expect(
      resolveInheritedAssignee(
        space({ defaultCaregiverId: 'lee', rotation: rotation() }),
        ctx(vacations),
        new Date(ANCHOR)
      )
    ).toEqual({ userId: null, name: null, source: null });
  });

  it('ignores members who have left, in the rotation and in the default alike', () => {
    expect(
      resolveInheritedAssignee(
        space({ rotation: rotation({ memberIds: ['gone', 'priya'] }) }),
        ctx(),
        new Date(ANCHOR)
      )
    ).toEqual({ userId: 'priya', name: 'Priya', source: 'rotation' });
    expect(
      resolveInheritedAssignee(space({ defaultCaregiverId: 'gone' }), ctx(), new Date(ANCHOR))
    ).toEqual({ userId: null, name: null, source: null });
  });

  it('a space with neither rotation nor default inherits nobody', () => {
    expect(resolveInheritedAssignee(space(), ctx(), new Date(ANCHOR))).toEqual({
      userId: null,
      name: null,
      source: null,
    });
    expect(resolveInheritedAssignee(null, ctx(), new Date(ANCHOR))).toEqual({
      userId: null,
      name: null,
      source: null,
    });
  });

  it('rotation + manual assignment: an explicitly assigned task never reaches inheritance', () => {
    // The guard callers use before resolving. This is the whole protection:
    // a claim and a manual assignment are both "explicit".
    const manual = task({ assignedTo: 'lee', assignedToName: 'Lee' });
    expect(isExplicitAssignment(manual)).toBe(true);
    const rotated = task({
      assignedTo: 'sam',
      assignedToName: 'Sam',
      assignmentSource: 'rotation',
    });
    expect(isExplicitAssignment(rotated)).toBe(false);
    // ...and a rotation-assigned task reads back as its own source.
    expect(resolveAssignment(rotated, ctx(), new Date(ANCHOR)).source).toBe('rotation');
  });
});
