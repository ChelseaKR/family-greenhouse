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
    expect(computeStreak(baseTask, [])).toEqual({ cycles: 0, truncated: false });
  });

  it('returns 1 for a single completion', () => {
    expect(computeStreak(baseTask, [completion('t1', 1)])).toEqual({
      cycles: 1,
      truncated: false,
    });
  });

  it('counts consecutive on-time completions', () => {
    // Frequency 7, slack 10.5 — 0, 7, 14, 21 days ago all on-time.
    const cs = [
      completion('t1', 0),
      completion('t1', 7),
      completion('t1', 14),
      completion('t1', 21),
    ];
    expect(computeStreak(baseTask, cs)).toEqual({ cycles: 4, truncated: false });
  });

  it('breaks the streak when a gap exceeds 1.5x frequency', () => {
    // 0, 7, then a 20-day gap (way over 10.5d slack). Streak from newest = 2.
    const cs = [completion('t1', 0), completion('t1', 7), completion('t1', 27)];
    expect(computeStreak(baseTask, cs)).toEqual({ cycles: 2, truncated: false });
  });

  it('ignores completions from a different task', () => {
    const cs = [completion('t1', 0), completion('other', 7)];
    expect(computeStreak(baseTask, cs)).toEqual({ cycles: 1, truncated: false });
  });

  describe('staleness (a lapsed streak is not a current streak)', () => {
    it('returns 0 when the newest completion is older than 1.5x frequency', () => {
      // A perfect weekly run… that ended 17 months ago. Not current.
      const cs = [completion('t1', 510), completion('t1', 517), completion('t1', 524)];
      expect(computeStreak(baseTask, cs).cycles).toBe(0);
    });

    it('returns 0 just past the slack window and the streak just inside it', () => {
      // frequency 7 → slack 10.5 days.
      expect(computeStreak(baseTask, [completion('t1', 11), completion('t1', 18)]).cycles).toBe(0);
      expect(computeStreak(baseTask, [completion('t1', 10), completion('t1', 17)]).cycles).toBe(2);
    });

    it('still reports the lapsed run via longestStreak', () => {
      const cs = [completion('t1', 510), completion('t1', 517), completion('t1', 524)];
      expect(longestStreak(baseTask, cs)).toBe(3);
    });
  });

  describe('window truncation (the count is a floor, not a measurement)', () => {
    it('is exact when the window came back short of its limit', () => {
      // Three rows out of a ten-row window: the plant really has no more
      // history, so nothing is hidden behind the cap.
      const cs = [completion('t1', 0), completion('t1', 7), completion('t1', 14)];
      expect(computeStreak(baseTask, cs, 10)).toEqual({ cycles: 3, truncated: false });
    });

    it('flags truncation when an unbroken run consumes a saturated window', () => {
      // Ten on-time completions filling a ten-row window. `GET /plants/{id}`
      // returned exactly its cap, so there is at least an eleventh completion
      // it did not send — the real streak may be far longer than ten.
      const cs = Array.from({ length: 10 }, (_, i) => completion('t1', i * 7));
      expect(computeStreak(baseTask, cs, 10)).toEqual({ cycles: 10, truncated: true });
    });

    it('is exact when a real gap ends the run inside a saturated window', () => {
      // Window is full, but the run stops at a genuine 30-day gap rather than
      // at the window edge, so the count is a measurement after all.
      const cs = [
        completion('t1', 0),
        completion('t1', 7),
        completion('t1', 37),
        ...Array.from({ length: 7 }, (_, i) => completion('t1', 44 + i * 7)),
      ];
      expect(computeStreak(baseTask, cs, 10)).toEqual({ cycles: 2, truncated: false });
    });

    it('counts rows from OTHER tasks toward saturation', () => {
      // The regression this fixes: the ten-row window is shared across every
      // task on the plant. Two water rows plus eight fertilize rows saturate
      // it, so a two-cycle watering reading is a floor even though only two
      // of the ten rows belong to this task.
      const cs = [
        completion('t1', 0),
        completion('t1', 7),
        ...Array.from({ length: 8 }, (_, i) => completion('t2', i * 7)),
      ];
      expect(computeStreak(baseTask, cs, 10)).toEqual({ cycles: 2, truncated: true });
    });

    it('does not flag truncation for a stale run', () => {
      // No current streak to understate.
      const cs = Array.from({ length: 10 }, (_, i) => completion('t1', 510 + i * 7));
      expect(computeStreak(baseTask, cs, 10)).toEqual({ cycles: 0, truncated: false });
    });
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
  const exact = (cycles: number) => ({ cycles, truncated: false });
  const floor = (cycles: number) => ({ cycles, truncated: true });

  it('returns null for streak < 2', () => {
    expect(streakLabel(baseTask, exact(0))).toBeNull();
    expect(streakLabel(baseTask, exact(1))).toBeNull();
    // Even a truncated one-cycle reading claims nothing worth a chip.
    expect(streakLabel(baseTask, floor(1))).toBeNull();
  });

  it('uses the task type as a verb', () => {
    expect(streakLabel(baseTask, exact(5))).toContain('watering');
    expect(streakLabel({ ...baseTask, type: 'fertilize' }, exact(3))).toContain('fertilizing');
    expect(streakLabel({ ...baseTask, type: 'prune' }, exact(4))).toContain('pruning');
  });

  it('falls back to custom type for custom tasks', () => {
    const task = { ...baseTask, type: 'custom' as const, customType: 'Misting' };
    expect(streakLabel(task, exact(3))).toContain('misting');
  });

  it('states an exact reading as a plain count', () => {
    expect(streakLabel(baseTask, exact(4))).toBe('4-cycle watering streak');
  });

  it('marks a truncated reading as a floor and names the window', () => {
    // The defect: this used to render "4-cycle watering streak" for a run the
    // window could not see the end of.
    const label = streakLabel(baseTask, floor(4), 10);
    expect(label).toBe('4+ cycle watering streak (within the last 10 logged)');
    expect(label).not.toBe('4-cycle watering streak');
  });

  it('never renders a truncated reading without the + marker', () => {
    for (const cycles of [2, 3, 10, 25]) {
      expect(streakLabel(baseTask, floor(cycles))).toContain(`${cycles}+ cycle`);
    }
  });
});
