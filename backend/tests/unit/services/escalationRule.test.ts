import { describe, expect, it } from 'vitest';
import type { Task } from '../../../src/models/types.js';
import {
  MAX_ESCALATE_AFTER_DAYS,
  MIN_ESCALATE_AFTER_DAYS,
  composeEscalationNotification,
  daysOverdue,
  escalationCandidates,
  escalationRecipients,
  normalizeEscalateAfterDays,
} from '../../../src/services/escalationRule.js';

const NOW = new Date('2026-06-10T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const overdueBy = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

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
    nextDue: overdueBy(6),
    assignedTo: 'sam',
    assignedToName: 'Sam',
    assignmentSource: null,
    notes: null,
    createdBy: 'sam',
    createdAt: '',
    ...overrides,
  };
}

describe('escalationRule — the floor', () => {
  it('pins the brief’s guardrail: minimum 5 days overdue', () => {
    expect(MIN_ESCALATE_AFTER_DAYS).toBe(5);
    expect(MAX_ESCALATE_AFTER_DAYS).toBe(60);
  });

  it('reads anything below the floor, above the ceiling, or malformed as OFF', () => {
    expect(normalizeEscalateAfterDays(undefined)).toBeNull();
    expect(normalizeEscalateAfterDays(null)).toBeNull();
    expect(normalizeEscalateAfterDays(0)).toBeNull();
    expect(normalizeEscalateAfterDays(4)).toBeNull();
    expect(normalizeEscalateAfterDays(5.5)).toBeNull();
    expect(normalizeEscalateAfterDays('7')).toBeNull();
    expect(normalizeEscalateAfterDays(61)).toBeNull();
    expect(normalizeEscalateAfterDays(5)).toBe(5);
    expect(normalizeEscalateAfterDays(60)).toBe(60);
  });
});

describe('escalationRule — candidates', () => {
  it('counts whole days overdue and never negative', () => {
    expect(daysOverdue({ nextDue: overdueBy(6) }, NOW)).toBe(6);
    expect(daysOverdue({ nextDue: overdueBy(0.9) }, NOW)).toBe(0);
    expect(daysOverdue({ nextDue: new Date(NOW.getTime() + DAY).toISOString() }, NOW)).toBe(0);
    expect(daysOverdue({ nextDue: 'not a date' }, NOW)).toBe(0);
  });

  it('with the rule off, nothing is a candidate however overdue', () => {
    expect(escalationCandidates([task({ nextDue: overdueBy(40) })], null, NOW)).toEqual([]);
    // A stored value under the floor is treated as off, not as "escalate sooner".
    expect(escalationCandidates([task({ nextDue: overdueBy(40) })], 2, NOW)).toEqual([]);
  });

  it('selects tasks at or past the threshold, assigned or unclaimed alike', () => {
    const assigned = task({ id: 'a', nextDue: overdueBy(5) });
    const unassigned = task({
      id: 'b',
      nextDue: overdueBy(9),
      assignedTo: null,
      assignedToName: null,
    });
    const fresh = task({ id: 'c', nextDue: overdueBy(4) });
    expect(escalationCandidates([assigned, unassigned, fresh], 5, NOW).map((t) => t.id)).toEqual([
      'a',
      'b',
    ]);
  });

  it('never escalates the same occurrence twice (escalation + claim included)', () => {
    const due = overdueBy(8);
    const alreadyEscalated = task({
      id: 'a',
      nextDue: due,
      escalatedForDue: due,
      assignedTo: null,
    });
    // Claimed after the escalation: still the same occurrence, still once-only.
    const claimedAfter = task({ id: 'b', nextDue: due, escalatedForDue: due, assignedTo: 'lee' });
    // A completion advanced nextDue: the marker is stale, the lapse is new.
    const rearmed = task({ id: 'c', nextDue: due, escalatedForDue: overdueBy(20) });
    expect(
      escalationCandidates([alreadyEscalated, claimedAfter, rearmed], 5, NOW).map((t) => t.id)
    ).toEqual(['c']);
  });
});

describe('escalationRule — recipients', () => {
  const members = [{ userId: 'sam' }, { userId: 'priya' }, { userId: 'lee' }];
  const nobody = () => false;

  it('tells everyone except the previous holder', () => {
    expect(escalationRecipients(members, 'sam', nobody, nobody).map((m) => m.userId)).toEqual([
      'priya',
      'lee',
    ]);
  });

  it('tells everyone when the task was unclaimed', () => {
    expect(escalationRecipients(members, null, nobody, nobody)).toHaveLength(3);
  });

  it('escalation + vacation: skips members who are away', () => {
    const away = (id: string) => id === 'priya';
    expect(escalationRecipients(members, 'sam', away, nobody).map((m) => m.userId)).toEqual([
      'lee',
    ]);
  });

  it('skips members inside their DND window', () => {
    const dnd = (id: string) => id === 'lee';
    expect(escalationRecipients(members, 'sam', nobody, dnd).map((m) => m.userId)).toEqual([
      'priya',
    ]);
  });

  it('can legitimately resolve to nobody (all away or quiet) — a real outcome, not an error', () => {
    expect(escalationRecipients(members, 'sam', () => true, nobody)).toEqual([]);
  });
});

describe('escalationRule — the one template, both languages', () => {
  const items = [
    { plantName: 'Monstera', taskType: 'water', daysOverdue: 6 },
    { plantName: 'Fern', taskType: 'fertilize', daysOverdue: 1 },
  ];

  it('English', () => {
    const { title, body } = composeEscalationNotification('en', items);
    expect(title).toBe('2 plant tasks are up for grabs');
    expect(body).toBe(
      'Water for Monstera has been waiting 6 days.\n' +
        'Fertilize for Fern has been waiting 1 day.\n\n' +
        'Nobody has to ask — claim it if you can.'
    );
    expect(composeEscalationNotification('en', items.slice(0, 1)).title).toBe(
      'A plant task is up for grabs'
    );
  });

  it('Spanish', () => {
    const { title, body } = composeEscalationNotification('es', items);
    expect(title).toBe('2 tareas de plantas están disponibles');
    expect(body).toBe(
      'Water de Monstera lleva 6 días esperando.\n' +
        'Fertilize de Fern lleva 1 día esperando.\n\n' +
        'Nadie tiene que pedirlo: reclámala si puedes.'
    );
    expect(composeEscalationNotification('es', items.slice(0, 1)).title).toBe(
      'Una tarea de plantas está disponible'
    );
  });

  it('never names the person the task was taken from', () => {
    const { title, body } = composeEscalationNotification('en', items);
    expect(`${title}\n${body}`).not.toMatch(/Sam|Priya|Lee/);
  });
});
