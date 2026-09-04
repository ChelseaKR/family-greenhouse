import { describe, expect, it } from 'vitest';
import type { ActivityEvent, HouseholdMember } from '@/services/householdService';
import type { TaskWithCoverage } from '@/services/taskService';
import { buildCareLoad, KIOSK_ENTRY_KEY, SITTER_ENTRY_KEY } from './careLoad';

const NOW = Date.parse('2026-06-15T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const member = (userId: string, name: string): HouseholdMember => ({
  userId,
  name,
  role: 'member',
  joinedAt: '2026-01-01T00:00:00.000Z',
});

const completion = (actorId: string, actorName: string, daysAgo: number): ActivityEvent => ({
  id: `${actorId}-${daysAgo}`,
  type: 'task.completed',
  householdId: 'hh',
  actorId,
  actorName,
  occurredAt: new Date(NOW - daysAgo * DAY).toISOString(),
  payload: { taskId: 't', plantId: 'p', taskType: 'water' },
});

const task = (id: string, assignedTo: string | null, extra: Partial<TaskWithCoverage> = {}) =>
  ({
    id,
    plantId: 'p',
    plantName: 'Monstera',
    type: 'water',
    frequency: 7,
    lastCompleted: null,
    nextDue: '2026-06-16T00:00:00.000Z',
    assignedTo,
    assignedToName: assignedTo ? assignedTo.toUpperCase() : null,
    notes: null,
    createdBy: 'u1',
    createdAt: '',
    ...extra,
  }) as TaskWithCoverage;

const members = [member('u1', 'Alice'), member('u2', 'Bob')];

function build(overrides: {
  activity?: ActivityEvent[];
  tasks?: TaskWithCoverage[];
  activityLimit?: number;
  members?: HouseholdMember[];
}) {
  return buildCareLoad({
    members: overrides.members ?? members,
    activity: overrides.activity ?? [],
    activityLimit: overrides.activityLimit ?? 200,
    tasks: overrides.tasks ?? [],
    now: NOW,
  });
}

describe('buildCareLoad', () => {
  it('lists every member even when they have done nothing, so absence is visible', () => {
    const summary = build({ activity: [completion('u1', 'Alice', 2)] });

    expect(summary.entries.map((e) => [e.key, e.completed])).toEqual([
      ['u1', 1],
      ['u2', 0],
    ]);
    expect(summary.totalCompleted).toBe(1);
    expect(summary.entries[1].share).toBe(0);
  });

  it('ignores completions older than the window', () => {
    const summary = build({
      activity: [completion('u1', 'Alice', 2), completion('u1', 'Alice', 45)],
    });

    expect(summary.totalCompleted).toBe(1);
    expect(summary.capped).toBe(false);
    expect(summary.periodStart).toBe(new Date(NOW - 30 * DAY).toISOString());
  });

  it('counts only task completions, not other activity', () => {
    const planted: ActivityEvent = {
      id: 'a',
      type: 'plant.created',
      householdId: 'hh',
      actorId: 'u2',
      actorName: 'Bob',
      occurredAt: new Date(NOW - DAY).toISOString(),
      payload: { plantId: 'p', plantName: 'Fern' },
    };
    const summary = build({ activity: [planted, completion('u1', 'Alice', 1)] });

    expect(summary.totalCompleted).toBe(1);
    expect(summary.entries.find((e) => e.key === 'u2')?.completed).toBe(0);
  });

  it('pools every sitter link into one row instead of naming link ids', () => {
    const summary = build({
      activity: [
        completion('sitter:link-a', 'a plant sitter', 1),
        completion('sitter:link-b', 'a plant sitter', 2),
        completion('u1', 'Alice', 3),
      ],
    });

    const sitter = summary.entries.find((e) => e.key === SITTER_ENTRY_KEY);
    expect(sitter).toMatchObject({ kind: 'sitter', completed: 2, holding: 0 });
    expect(summary.entries.some((e) => e.key.includes('link-a'))).toBe(false);
  });

  it('pools wall-display completions into their own row, never as a "past" member', () => {
    const summary = build({
      activity: [
        completion('kiosk:link-1', 'the kiosk display', 1),
        completion('kiosk:link-1', 'the kiosk display', 2),
        completion('u1', 'Alice', 3),
      ],
    });

    const kiosk = summary.entries.find((e) => e.key === KIOSK_ENTRY_KEY);
    // 'past' renders as "no longer in the household", which would be a false
    // statement about a screen on the kitchen wall.
    expect(kiosk).toMatchObject({ kind: 'kiosk', completed: 2, holding: 0 });
    expect(kiosk?.name).toBe('');
    expect(summary.entries.some((e) => e.key.includes('link-1'))).toBe(false);
  });

  it('keeps a departed member in the tally so the remaining shares still add up', () => {
    const summary = build({
      activity: [completion('u1', 'Alice', 1), completion('gone', 'Casey', 2)],
    });

    const shares = summary.entries.reduce((total, entry) => total + entry.share, 0);
    expect(shares).toBeCloseTo(1);
    expect(summary.entries.find((e) => e.key === 'gone')).toMatchObject({
      kind: 'past',
      name: 'Casey',
    });
  });

  it('counts what each person is holding, crediting the covering member', () => {
    const summary = build({
      tasks: [
        task('t1', 'u1'),
        task('t2', 'u1', { effectiveAssignee: 'u2', effectiveAssigneeName: 'Bob' }),
        task('t3', null),
        task('t4', null),
      ],
    });

    expect(summary.entries.find((e) => e.key === 'u1')?.holding).toBe(1);
    expect(summary.entries.find((e) => e.key === 'u2')?.holding).toBe(1);
    expect(summary.upForGrabs).toBe(2);
  });

  it('surfaces a standing assignment left behind by someone who has left', () => {
    const summary = build({ tasks: [task('t1', 'gone')] });

    expect(summary.entries.find((e) => e.key === 'gone')).toMatchObject({
      kind: 'past',
      holding: 1,
      completed: 0,
    });
    expect(summary.upForGrabs).toBe(0);
  });

  it('names the member carrying most of the load once there is enough to go on', () => {
    const activity = [
      ...Array.from({ length: 8 }, (_, i) => completion('u1', 'Alice', i + 1)),
      completion('u2', 'Bob', 2),
    ];
    const summary = build({ activity });

    expect(summary.leadCarrier?.key).toBe('u1');
  });

  it('stays quiet when the split is even', () => {
    const activity = [
      ...Array.from({ length: 4 }, (_, i) => completion('u1', 'Alice', i + 1)),
      ...Array.from({ length: 4 }, (_, i) => completion('u2', 'Bob', i + 1)),
    ];

    expect(build({ activity }).leadCarrier).toBeNull();
  });

  it('stays quiet on a handful of completions, where a share means nothing', () => {
    const activity = [completion('u1', 'Alice', 1), completion('u1', 'Alice', 2)];

    expect(build({ activity }).leadCarrier).toBeNull();
  });

  it('never singles out a lone member', () => {
    const activity = Array.from({ length: 9 }, (_, i) => completion('u1', 'Alice', i + 1));

    expect(build({ activity, members: [member('u1', 'Alice')] }).leadCarrier).toBeNull();
  });

  it('reports the real horizon when the activity feed was capped short of the window', () => {
    // A busy household: the feed's page limit is reached six days back, so the
    // counts cover six days — claiming "the last 30 days" would print a share
    // computed over a period we never saw.
    const activity = Array.from({ length: 10 }, (_, i) => completion('u1', 'Alice', i * 0.6));
    const summary = build({ activity, activityLimit: 10 });

    expect(summary.capped).toBe(true);
    expect(summary.periodStart).toBe(new Date(NOW - 5.4 * DAY).toISOString());
  });

  it('is not capped when a full page still reaches past the window', () => {
    const activity = [
      ...Array.from({ length: 9 }, (_, i) => completion('u1', 'Alice', i)),
      completion('u1', 'Alice', 40),
    ];
    const summary = build({ activity, activityLimit: 10 });

    expect(summary.capped).toBe(false);
    expect(summary.totalCompleted).toBe(9);
  });
});
