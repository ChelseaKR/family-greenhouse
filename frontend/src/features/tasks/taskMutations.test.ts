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

  it('moves a completed row to its next due date instead of dropping it', () => {
    // The server's upcoming window is seven days and completion advances
    // nextDue by the task's frequency, so a task recurring every <= 7 days is
    // immediately upcoming again. Filtering it out here made it vanish and
    // then reappear on the refetch, which reads as "it didn't save".
    expect(
      replaceCompletedTaskInTaskQuery(['tasks', 'household-1', 'upcoming'], [task], completed)
    ).toEqual([completed]);
  });

  it('keeps the row for a task whose next occurrence falls outside the window', () => {
    // Not a special case in the client: the row is replaced either way, and
    // the authoritative refetch is what removes it if the server no longer
    // considers it upcoming. Pinning this stops a future "optimise" from
    // reintroducing client-side guessing about the server's window.
    const farFuture = { ...completed, nextDue: '2026-12-25T09:00:00.000Z' };
    expect(
      replaceCompletedTaskInTaskQuery(['tasks', 'household-1', 'upcoming'], [task], farFuture)
    ).toEqual([farFuture]);
  });

  it('leaves rows for other tasks untouched', () => {
    const other = { ...task, id: 'task-other' };
    expect(
      replaceCompletedTaskInTaskQuery(
        ['tasks', 'household-1', 'upcoming'],
        [task, other],
        completed
      )
    ).toEqual([completed, other]);
  });
});
