import { describe, expect, it } from 'vitest';
import type { Plant, PlantSpace, Task } from '@/services/plantService';
import { buildCareRoundGroups, filterTasksForSpace, mostOverdueFirst } from './careRounds';

const spaces: PlantSpace[] = [
  {
    id: 'patio',
    householdId: 'hh',
    name: 'Patio',
    environment: 'outside',
    createdAt: '',
    createdBy: 'u',
    updatedAt: '',
  },
  {
    id: 'kitchen',
    householdId: 'hh',
    name: 'Kitchen',
    environment: 'inside',
    createdAt: '',
    createdBy: 'u',
    updatedAt: '',
  },
];

const plant = (id: string, spaceId?: string): Plant => ({
  id,
  householdId: 'hh',
  name: id,
  species: null,
  location: null,
  spaceId,
  imageUrl: null,
  notes: null,
  createdAt: '',
  createdBy: 'u',
  updatedAt: '',
});

const task = (id: string, plantId: string): Task => ({
  id,
  plantId,
  plantName: plantId,
  type: 'water',
  frequency: 7,
  lastCompleted: null,
  nextDue: '2026-07-15T12:00:00.000Z',
  assignedTo: null,
  assignedToName: null,
  notes: null,
  createdBy: 'u',
  createdAt: '',
});

describe('buildCareRoundGroups', () => {
  it('orders inside, outside, then unplaced while preserving task order', () => {
    const result = buildCareRoundGroups(
      [task('outside-1', 'p2'), task('inside-1', 'p1'), task('inside-2', 'p1'), task('none', 'p3')],
      [plant('p1', 'kitchen'), plant('p2', 'patio'), plant('p3')],
      spaces
    );
    expect(result.map((group) => `${group.environment}:${group.name}`)).toEqual([
      'inside:Kitchen',
      'outside:Patio',
      'unplaced:Unplaced',
    ]);
    expect(result[0].tasks.map((item) => item.id)).toEqual(['inside-1', 'inside-2']);
  });
});

describe('mostOverdueFirst', () => {
  const NOW = new Date(2026, 6, 15, 12);
  const dueOn = (id: string, plantId: string, day: number, hour = 12): Task => ({
    ...task(id, plantId),
    nextDue: new Date(2026, 6, day, hour).toISOString(),
  });

  it('starts the round in the room with the most overdue task, not the first on the route', () => {
    const groups = buildCareRoundGroups(
      [dueOn('k', 'p1', 15), dueOn('p', 'p2', 12)],
      [plant('p1', 'kitchen'), plant('p2', 'patio')],
      spaces
    );
    expect(groups.map((g) => g.name)).toEqual(['Kitchen', 'Patio']); // the route
    expect(mostOverdueFirst(groups, NOW).map((g) => g.name)).toEqual(['Patio', 'Kitchen']);
  });

  it('keeps the route order between rooms due the same day, whatever the hour', () => {
    const groups = buildCareRoundGroups(
      [dueOn('p', 'p2', 15, 6), dueOn('k', 'p1', 15, 22)],
      [plant('p1', 'kitchen'), plant('p2', 'patio')],
      spaces
    );
    expect(mostOverdueFirst(groups, NOW).map((g) => g.name)).toEqual(['Kitchen', 'Patio']);
  });
});

describe('filterTasksForSpace', () => {
  const tasks = [
    task('inside', 'p1'),
    task('outside', 'p2'),
    task('none', 'p3'),
    task('stale', 'p4'),
  ];
  const plants = [
    plant('p1', 'kitchen'),
    plant('p2', 'patio'),
    plant('p3'),
    plant('p4', 'deleted-space'),
  ];

  it('returns only work in the requested current space', () => {
    expect(filterTasksForSpace(tasks, plants, spaces, 'kitchen').map((item) => item.id)).toEqual([
      'inside',
    ]);
  });

  it('treats missing and deleted space references as unplaced', () => {
    expect(filterTasksForSpace(tasks, plants, spaces, 'unplaced').map((item) => item.id)).toEqual([
      'none',
      'stale',
    ]);
  });
});
