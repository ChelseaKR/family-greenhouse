import { describe, expect, it } from 'vitest';
import { careWho, groupPlantCare, plantCare, type PlantCare } from '@/features/plants/plantCare';
import type { Plant } from '@/services/plantService';
import type { TaskWithCoverage } from '@/services/taskService';

const NOW = new Date(2026, 9, 3, 9, 0, 0); // Oct 3 2026, 09:00 local

function plant(id: string, name: string, spaceId: string | null = null): Plant {
  return {
    id,
    householdId: 'hh',
    name,
    species: null,
    location: null,
    spaceId,
    imageUrl: null,
    notes: null,
    createdAt: '',
    createdBy: '',
    updatedAt: '',
  };
}

function task(
  id: string,
  plantId: string,
  dueInDays: number,
  extra: Partial<TaskWithCoverage> = {}
) {
  const due = new Date(NOW);
  due.setDate(due.getDate() + dueInDays);
  due.setHours(23, 0, 0, 0);
  return {
    id,
    plantId,
    plantName: plantId,
    type: 'water',
    frequency: 7,
    lastCompleted: null,
    nextDue: due.toISOString(),
    assignedTo: null,
    assignedToName: null,
    notes: null,
    createdBy: 'u',
    createdAt: '',
    ...extra,
  } as TaskWithCoverage;
}

describe('plantCare buckets', () => {
  it('puts each plant under its MOST urgent task', () => {
    const [item] = plantCare([plant('p', 'Fig')], [task('a', 'p', 5), task('b', 'p', -2)], NOW);
    expect(item.task?.id).toBe('b');
    expect(item.days).toBe(-2);
    expect(item.bucket).toBe('needs');
  });

  it('counts today as needs care, 1–7 days as soon, later as later', () => {
    const items = plantCare(
      [plant('a', 'A'), plant('b', 'B'), plant('c', 'C'), plant('d', 'D')],
      [task('1', 'a', 0), task('2', 'b', 1), task('3', 'c', 7), task('4', 'd', 8)],
      NOW
    );
    expect(items.map((i) => i.bucket)).toEqual(['needs', 'soon', 'soon', 'later']);
  });

  it('a plant with no task is "none", never a healthy bucket', () => {
    const [item] = plantCare([plant('p', 'Fig')], [], NOW);
    expect(item.bucket).toBe('none');
    expect(item.task).toBeUndefined();
  });
});

describe('groupPlantCare', () => {
  const items: PlantCare[] = plantCare(
    [
      plant('a', 'Zz', 's2'),
      plant('b', 'Aloe', 's1'),
      plant('c', 'Fern', 's1'),
      plant('d', 'Bare'),
    ],
    [task('1', 'a', -1), task('2', 'b', 0), task('3', 'c', 20)],
    NOW
  );
  const roomOf = (p: Plant) => p.spaceId ?? 'unplaced';

  it('orders care sections needs → soon → later → none and drops empty ones', () => {
    const sections = groupPlantCare(items, 'care', roomOf, ['s1', 's2']);
    expect(sections.map((s) => s.id)).toEqual(['needs', 'later', 'none']);
    // Overdue before due today.
    expect(sections[0].items.map((i) => i.plant.name)).toEqual(['Zz', 'Aloe']);
    expect(sections[2].items.map((i) => i.plant.name)).toEqual(['Bare']);
  });

  it('groups by room in the household order, unplaced last, urgent first inside', () => {
    const sections = groupPlantCare(items, 'room', roomOf, ['s1', 's2']);
    expect(sections.map((s) => s.id)).toEqual(['s1', 's2', 'unplaced']);
    expect(sections[0].items.map((i) => i.plant.name)).toEqual(['Aloe', 'Fern']);
  });

  it('groups by name as one alphabetical section', () => {
    const [only] = groupPlantCare(items, 'name', roomOf, []);
    expect(only.items.map((i) => i.plant.name)).toEqual(['Aloe', 'Bare', 'Fern', 'Zz']);
  });
});

describe('careWho', () => {
  it('names the covering member, not the assignee who is away', () => {
    const t = task('1', 'p', 0, {
      assignedTo: 'dana',
      assignedToName: 'Dana',
      effectiveAssignee: 'theo',
      effectiveAssigneeName: 'Theo',
      coveringFor: 'Dana',
    });
    expect(careWho(t, 'me')).toEqual({ kind: 'member', name: 'Theo', coveringFor: 'Dana' });
  });

  it('says "you" when the effective assignee is the viewer', () => {
    const t = task('1', 'p', 0, { assignedTo: 'me', assignedToName: 'Me' });
    expect(careWho(t, 'me').kind).toBe('you');
  });

  it('an unassigned task is open', () => {
    expect(careWho(task('1', 'p', 0), 'me')).toEqual({ kind: 'open' });
  });

  it('an assigned task whose name did not load is still assigned, not open', () => {
    const t = task('1', 'p', 0, { assignedTo: 'x', assignedToName: null });
    expect(careWho(t, 'me')).toEqual({ kind: 'member', name: null, coveringFor: null });
  });
});
