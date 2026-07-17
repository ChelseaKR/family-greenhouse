import { describe, expect, it } from 'vitest';
import type { HouseholdMember } from '@/services/householdService';
import type { Plant, PlantSpace, Task } from '@/services/plantService';
import { buildSpaceOverviewGroups } from './spaceOverview';

const spaces: PlantSpace[] = [
  {
    id: 'patio',
    householdId: 'hh',
    name: 'Patio',
    environment: 'outside',
    defaultCaregiverId: 'u2',
    createdAt: '',
    createdBy: 'u1',
    updatedAt: '',
  },
  {
    id: 'office',
    householdId: 'hh',
    name: 'Office',
    environment: 'inside',
    createdAt: '',
    createdBy: 'u1',
    updatedAt: '',
  },
  {
    id: 'kitchen',
    householdId: 'hh',
    name: 'Kitchen',
    environment: 'inside',
    createdAt: '',
    createdBy: 'u1',
    updatedAt: '',
  },
];

const plant = (id: string, spaceId?: string, overrides: Partial<Plant> = {}): Plant => ({
  id,
  householdId: 'hh',
  name: id,
  species: null,
  location: null,
  spaceId,
  imageUrl: null,
  notes: null,
  createdAt: '',
  createdBy: 'u1',
  updatedAt: '',
  ...overrides,
});

const task = (id: string, plantId: string, nextDue: string): Task => ({
  id,
  plantId,
  plantName: plantId,
  type: 'water',
  frequency: 7,
  lastCompleted: null,
  nextDue,
  assignedTo: null,
  assignedToName: null,
  notes: null,
  createdBy: 'u1',
  createdAt: '',
});

const members: HouseholdMember[] = [{ userId: 'u2', name: 'Sam', role: 'member', joinedAt: '' }];

describe('buildSpaceOverviewGroups', () => {
  it('orders the care route inside by name, then outside, then unplaced', () => {
    const groups = buildSpaceOverviewGroups(
      [plant('p1', 'office'), plant('p2', 'patio'), plant('p3'), plant('p4', 'missing')],
      spaces,
      []
    );

    expect(groups.map((group) => `${group.environment}:${group.name}`)).toEqual([
      'inside:Office',
      'outside:Patio',
      'unplaced:Unplaced',
    ]);
    expect(groups[2].plants.map((item) => item.id)).toEqual(['p3', 'p4']);
  });

  it('counts overdue and today work and keeps the earliest task', () => {
    const now = new Date(2026, 6, 16, 9);
    const [group] = buildSpaceOverviewGroups(
      [plant('p1', 'office')],
      spaces,
      [
        task('tomorrow', 'p1', '2026-07-17T23:00:00.000Z'),
        task('overdue', 'p1', '2026-07-14T12:00:00.000Z'),
        task('today', 'p1', '2026-07-16T20:00:00.000Z'),
        task('other-space', 'p2', '2026-07-10T12:00:00.000Z'),
      ],
      [],
      null,
      now
    );

    expect(group).toMatchObject({
      taskCount: 3,
      overdueCount: 1,
      todayCount: 1,
      nextDue: '2026-07-14T12:00:00.000Z',
    });
  });

  it('resolves the usual caregiver and current seasonal moves', () => {
    const groups = buildSpaceOverviewGroups(
      [
        plant('fern', 'office', {
          name: 'Fern',
          summerSpaceId: 'patio',
          winterSpaceId: 'office',
        }),
        plant('aloe', 'patio'),
      ],
      spaces,
      [],
      members,
      45,
      new Date(2026, 6, 16)
    );

    expect(groups.find((group) => group.id === 'office')?.seasonalMoves).toEqual([
      {
        plantId: 'fern',
        plantName: 'Fern',
        targetSpaceId: 'patio',
        targetSpaceName: 'Patio',
      },
    ]);
    expect(groups.find((group) => group.id === 'patio')?.caregiverName).toBe('Sam');
  });
});
