import { describe, expect, it } from 'vitest';
import type { TaskWithCoverage } from '@/services/taskService';
import {
  byDueThenName,
  checklistItems,
  dateSections,
  roomSections,
  segmentCounts,
} from '@/features/tasks/checklistModel';

// Local noon on a fixed day, so "days from today" never depends on the clock.
const NOW = new Date(2026, 9, 4, 12, 0, 0);

function due(daysFromNow: number, hour = 9): string {
  const d = new Date(2026, 9, 4 + daysFromNow, hour, 0, 0);
  return d.toISOString();
}

function task(id: string, plantName: string, nextDue: string, type = 'water'): TaskWithCoverage {
  return {
    id,
    plantId: `p-${id}`,
    plantName,
    type,
    customType: null,
    frequency: 7,
    lastCompleted: null,
    nextDue,
    assignedTo: null,
    assignedToName: null,
    notes: null,
    createdBy: 'u1',
    createdAt: '',
  } as TaskWithCoverage;
}

const items = (tasks: TaskWithCoverage[]) => checklistItems(tasks, (t) => t.plantName, NOW);

describe('the phone Tasks checklist model', () => {
  it('orders tasks due the same day by plant name, never by the stored time of day', () => {
    // The API order and the times are both scrambled: Monstera is stored
    // earliest in the day, Aloe latest.
    const list = items([
      task('a', 'Monstera', due(0, 1)),
      task('b', 'Calathea', due(0, 15)),
      task('c', 'Aloe', due(0, 23)),
    ]).sort(byDueThenName);
    expect(list.map((i) => i.plantName)).toEqual(['Aloe', 'Calathea', 'Monstera']);
  });

  it('puts the most overdue first, then breaks ties by name and task kind', () => {
    const list = items([
      task('a', 'Fern', due(-1)),
      task('b', 'Ivy', due(-3)),
      task('c', 'Fern', due(-1), 'fertilize'),
      task('d', 'Basil', due(-1)),
    ]).sort(byDueThenName);
    expect(list.map((i) => `${i.plantName}:${i.task.type}`)).toEqual([
      'Ivy:water',
      'Basil:water',
      'Fern:fertilize',
      'Fern:water',
    ]);
  });

  it('Today holds Overdue then Today; Upcoming holds one section per day', () => {
    const list = items([
      task('a', 'Fern', due(2)),
      task('b', 'Ivy', due(0)),
      task('c', 'Aloe', due(-2)),
      task('d', 'Basil', due(1)),
      task('e', 'Cactus', due(2)),
    ]);
    const today = dateSections(list, 'today');
    expect(today.map((s) => [s.id, s.items.map((i) => i.plantName)])).toEqual([
      ['overdue', ['Aloe']],
      ['today', ['Ivy']],
    ]);
    const upcoming = dateSections(list, 'upcoming');
    expect(upcoming.map((s) => [s.id, s.days, s.items.map((i) => i.plantName)])).toEqual([
      ['day:1', 1, ['Basil']],
      ['day:2', 2, ['Cactus', 'Fern']],
    ]);
    expect(segmentCounts(list)).toEqual({ today: 2, upcoming: 3 });
  });

  it('drops an empty section rather than showing a heading over nothing', () => {
    const today = dateSections(items([task('a', 'Fern', due(0))]), 'today');
    expect(today.map((s) => s.id)).toEqual(['today']);
    expect(dateSections(items([]), 'upcoming')).toEqual([]);
  });

  it('grouped by room: only the segment, the room with the most overdue task first', () => {
    const room: Record<string, string> = {
      Aloe: 'kitchen',
      Basil: 'kitchen',
      Lily: 'bedroom',
      Fig: 'living',
      Hoya: 'living',
    };
    const list = items([
      task('a', 'Aloe', due(0)),
      task('b', 'Basil', due(-1)),
      task('c', 'Lily', due(-3)),
      task('d', 'Fig', due(0)),
      task('e', 'Hoya', due(4)),
    ]);
    const order = ['living', 'kitchen', 'bedroom'];
    const today = roomSections(list, 'today', (i) => room[i.plantName], order);
    // Bedroom holds the most overdue (3 days), then Kitchen (1 day), then
    // Living Room (due today) - not the household's own room order.
    expect(today.map((s) => [s.id, s.items.map((i) => i.plantName)])).toEqual([
      ['bedroom', ['Lily']],
      ['kitchen', ['Basil', 'Aloe']],
      ['living', ['Fig']],
    ]);
    // Hoya is due in 4 days: Upcoming's round, never Today's.
    expect(roomSections(list, 'upcoming', (i) => room[i.plantName], order)).toEqual([
      { id: 'living', kind: 'room', items: [expect.objectContaining({ plantName: 'Hoya' })] },
    ]);
  });

  it('grouped by room: rooms with equally urgent work keep the household order', () => {
    const list = items([task('a', 'Aloe', due(0)), task('b', 'Fig', due(0))]);
    const room = (i: { plantName: string }) => (i.plantName === 'Aloe' ? 'kitchen' : 'living');
    expect(roomSections(list, 'today', room, ['living', 'kitchen']).map((s) => s.id)).toEqual([
      'living',
      'kitchen',
    ]);
  });
});
