import { describe, expect, it } from 'vitest';
import { computeStreak, longestStreak, streakLabel } from '@/utils/streaks';
import type { Task, TaskCompletion } from '@/services/plantService';

const baseTask: Task = {
  id: 't1',
  plantId: 'p1',
  plantName: 'Pothos',
  type: 'water',
  customType: undefined,
  frequency: 7,
  lastCompleted: null,
  nextDue: '2026-05-01',
  assignedTo: null,
  assignedToName: null,
  notes: null,
  createdBy: 'u',
  createdAt: '',
};

function completion(taskId: string, daysAgo: number): TaskCompletion {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return {
    id: `c-${daysAgo}`,
    taskId,
    taskType: 'water',
    completedBy: 'u',
    completedByName: 'A',
    completedAt: d.toISOString(),
    notes: null,
  };
}

describe('computeStreak', () => {
  it('returns 0 with no completions', () => {
    expect(computeStreak(baseTask, [])).toBe(0);
  });

  it('returns 1 for a single completion', () => {
    expect(computeStreak(baseTask, [completion('t1', 1)])).toBe(1);
  });

  it('counts consecutive on-time completions', () => {
    // Frequency 7, slack 10.5 — 0, 7, 14, 21 days ago all on-time.
    const cs = [
      completion('t1', 0),
      completion('t1', 7),
      completion('t1', 14),
      completion('t1', 21),
    ];
    expect(computeStreak(baseTask, cs)).toBe(4);
  });

  it('breaks the streak when a gap exceeds 1.5x frequency', () => {
    // 0, 7, then a 20-day gap (way over 10.5d slack). Streak from newest = 2.
    const cs = [completion('t1', 0), completion('t1', 7), completion('t1', 27)];
    expect(computeStreak(baseTask, cs)).toBe(2);
  });

  it('ignores completions from a different task', () => {
    const cs = [completion('t1', 0), completion('other', 7)];
    expect(computeStreak(baseTask, cs)).toBe(1);
  });
});

describe('longestStreak', () => {
  it('returns 0 with no completions', () => {
    expect(longestStreak(baseTask, [])).toBe(0);
  });

  it('finds the longest run even when an earlier streak is broken', () => {
    // 0, 7, 14 on-time (run of 3), 40-day gap, then 60, 67 on-time (run of 2).
    const cs = [
      completion('t1', 0),
      completion('t1', 7),
      completion('t1', 14),
      completion('t1', 60),
      completion('t1', 67),
    ];
    expect(longestStreak(baseTask, cs)).toBe(3);
  });

  it('matches computeStreak when the entire history is on-time', () => {
    const cs = [completion('t1', 0), completion('t1', 7), completion('t1', 14)];
    expect(longestStreak(baseTask, cs)).toBe(3);
  });
});

describe('streakLabel', () => {
  it('returns null for streak < 2', () => {
    expect(streakLabel(baseTask, 0)).toBeNull();
    expect(streakLabel(baseTask, 1)).toBeNull();
  });

  it('uses the task type as a verb', () => {
    expect(streakLabel(baseTask, 5)).toContain('watering');
    expect(streakLabel({ ...baseTask, type: 'fertilize' }, 3)).toContain('fertilizing');
    expect(streakLabel({ ...baseTask, type: 'prune' }, 4)).toContain('pruning');
  });

  it('falls back to custom type for custom tasks', () => {
    const task = { ...baseTask, type: 'custom' as const, customType: 'Misting' };
    expect(streakLabel(task, 3)).toContain('misting');
  });
});
