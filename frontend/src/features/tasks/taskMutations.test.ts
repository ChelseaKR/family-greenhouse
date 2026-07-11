import { describe, expect, it } from 'vitest';
import { Task } from '@/services/plantService';
import { replaceCompletedTaskInCache, replaceCompletedTaskInTaskQuery } from './taskMutations';

const task: Task = {
  id: 'task-1',
  plantId: 'plant-1',
  plantName: 'Monstera',
  type: 'water',
  frequency: 7,
  lastCompleted: null,
  nextDue: '2026-07-10T08:00:00.000Z',
  assignedTo: null,
  assignedToName: null,
  notes: null,
  createdBy: 'user-1',
  createdAt: '2026-07-01T08:00:00.000Z',
};

const completed = {
  ...task,
  lastCompleted: '2026-07-10T09:00:00.000Z',
  nextDue: '2026-07-17T09:00:00.000Z',
};

describe('replaceCompletedTaskInCache', () => {
  it('replaces stale task-list data with the authoritative completion response', () => {
    const staleList = [task, { ...task, id: 'task-2' }];

    expect(replaceCompletedTaskInCache(staleList, completed)).toEqual([
      completed,
      { ...task, id: 'task-2' },
    ]);
  });

  it('updates the task nested in a plant-detail response', () => {
    const plantDetail = {
      id: 'plant-1',
      upcomingTasks: [task],
      recentCompletions: [],
    };

    expect(replaceCompletedTaskInCache(plantDetail, completed)).toEqual({
      ...plantDetail,
      upcomingTasks: [completed],
    });
  });

  it('removes a completed row from the dashboard care queue', () => {
    expect(
      replaceCompletedTaskInTaskQuery(['tasks', 'household-1', 'upcoming'], [task], completed)
    ).toEqual([]);
  });
});
