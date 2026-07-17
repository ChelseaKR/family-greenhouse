import { describe, expect, it } from 'vitest';
import type { Plant, PlantSpace, Task } from '@/services/plantService';
import { buildCareRoundGroups, filterTasksForSpace } from './careRounds';

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
