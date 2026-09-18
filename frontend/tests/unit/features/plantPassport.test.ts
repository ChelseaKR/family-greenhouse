/**
 * The plant passport's privacy and honesty rules (#676), tested as the pure
 * functions they are. A passport is paper handed to someone OUTSIDE the
 * household, so it is held to the same rule as the three public token
 * surfaces that leaked a plant's private notes on 2026-09-13 (#732, #739,
 * #741): the house rule, never the notes.
 *
 * Every absence assertion here is paired with a control that proves the
 * secret was really in the input and really reachable — an "is not present"
 * check over a fixture that never carried the secret passes for the wrong
 * reason.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PASSPORT_HISTORY_DAYS,
  PASSPORT_HISTORY_LIMIT,
  initialsOf,
  passportHistory,
  passportHouseRule,
  passportNotes,
  passportPetSafety,
  passportSchedule,
} from '@/features/plants/plantPassport';
import type { TaskCompletion } from '@/services/plantService';

const NOW = new Date('2026-09-17T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();

const SECRET_NOTE = 'Spare key is under the blue pot';
const SECRET_COMPLETION_NOTE = 'Neighbour at no. 12 waters when we are away';

function completion(n: number, overrides: Partial<TaskCompletion> = {}): TaskCompletion {
  return {
    id: `c${n}`,
    taskId: 't1',
    taskType: 'water',
    completedBy: 'u1',
    completedByName: 'Chelsea Kelly-Reif',
    completedAt: daysAgo(n),
    notes: SECRET_COMPLETION_NOTE,
    ...overrides,
  };
}

describe('passportHouseRule — the resolveCareNote rule', () => {
  it('prints the trimmed house rule', () => {
    expect(passportHouseRule({ careRule: '  Bottom-water only  ' })).toBe('Bottom-water only');
  });

  it('never falls back to the private notes when there is no rule', () => {
    const plant = { careRule: null, notes: SECRET_NOTE };
    // Control: the notes are really on this plant, so null below is the rule
    // working rather than an empty fixture.
    expect(plant.notes).toContain('Spare key');
    expect(passportHouseRule(plant)).toBeNull();
    expect(passportHouseRule({ careRule: '   ', notes: SECRET_NOTE } as never)).toBeNull();
  });
});

describe('passportNotes — admin AND explicit consent, every time', () => {
  const plant = { notes: SECRET_NOTE };

  it.each([
    { includeNotes: false, isAdmin: false },
    { includeNotes: false, isAdmin: true },
    { includeNotes: true, isAdmin: false },
  ])('prints no notes for %o', (consent) => {
    expect(passportNotes(plant, consent)).toBeNull();
  });

  it('prints the notes only when an admin ticks "include my notes" (control)', () => {
    // The negative control for the three cases above: the same fixture, with
    // consent given, DOES come back — so their nulls are the guard, not a
    // fixture that had nothing to leak.
    expect(passportNotes(plant, { includeNotes: true, isAdmin: true })).toBe(SECRET_NOTE);
  });

  it('prints nothing rather than an empty notes block for blank notes', () => {
    expect(passportNotes({ notes: '  \n ' }, { includeNotes: true, isAdmin: true })).toBeNull();
    expect(passportNotes({ notes: null }, { includeNotes: true, isAdmin: true })).toBeNull();
  });
});

describe('initialsOf', () => {
  it.each([
    ['Chelsea Kelly-Reif', 'CK'],
    ['Joyce', 'J'],
    ['  maría   josé  garcía ', 'MG'],
    ['Ángela Núñez', 'ÁN'],
    ['😀 Smile', '😀S'],
  ])('%s → %s', (name, expected) => {
    expect(initialsOf(name)).toBe(expected);
  });

  it('is null for a blank or missing name', () => {
    expect(initialsOf('')).toBeNull();
    expect(initialsOf('   ')).toBeNull();
    expect(initialsOf(null)).toBeNull();
    expect(initialsOf(undefined)).toBeNull();
  });
});

describe('passportHistory', () => {
  const plant = { createdAt: daysAgo(400) };

  it('keeps no completion notes and shows initials by default', () => {
    const history = passportHistory([completion(3)], plant, { fullNames: false, now: NOW });
    if (history.status !== 'ok') throw new Error('expected ok');
    const [entry] = history.entries;
    expect(entry.who).toBe('CK');
    // The entry is copied field by field — there is no key a note could be in.
    expect(Object.keys(entry).sort()).toEqual(['completedAt', 'id', 'taskType', 'who']);
    expect(JSON.stringify(history)).not.toContain(SECRET_COMPLETION_NOTE);
    expect(JSON.stringify(history)).not.toContain('Chelsea');
  });

  it('shows the full name only when asked (control for the initials default)', () => {
    const history = passportHistory([completion(3)], plant, { fullNames: true, now: NOW });
    if (history.status !== 'ok') throw new Error('expected ok');
    expect(history.entries[0].who).toBe('Chelsea Kelly-Reif');
    // Still no completion note, even with full names on.
    expect(JSON.stringify(history)).not.toContain(SECRET_COMPLETION_NOTE);
  });

  it('is unavailable — never empty — when the read failed', () => {
    expect(passportHistory(undefined, plant, { fullNames: false, now: NOW })).toEqual({
      status: 'unavailable',
    });
  });

  it('keeps only the window, newest first', () => {
    const history = passportHistory(
      [completion(200), completion(10), completion(PASSPORT_HISTORY_DAYS + 1), completion(2)],
      plant,
      { fullNames: false, now: NOW }
    );
    if (history.status !== 'ok') throw new Error('expected ok');
    expect(history.entries.map((e) => e.id)).toEqual(['c2', 'c10']);
    expect(history.capped).toBe(false);
    expect(history.lastLoggedBeforeWindow).toBe(daysAgo(PASSPORT_HISTORY_DAYS + 1));
  });

  it('says the list may be cut short when a full read is still inside the window', () => {
    const full = Array.from({ length: PASSPORT_HISTORY_LIMIT }, (_, i) => completion(i + 1));
    const history = passportHistory(full, plant, { fullNames: false, now: NOW });
    if (history.status !== 'ok') throw new Error('expected ok');
    expect(history.entries).toHaveLength(PASSPORT_HISTORY_LIMIT);
    expect(history.capped).toBe(true);
  });

  it('trims a longer read to the server ceiling and still calls it capped', () => {
    // The local dev server returns every completion; production returns 20.
    const long = Array.from({ length: PASSPORT_HISTORY_LIMIT + 5 }, (_, i) => completion(i + 1));
    const history = passportHistory(long, plant, { fullNames: false, now: NOW });
    if (history.status !== 'ok') throw new Error('expected ok');
    expect(history.entries).toHaveLength(PASSPORT_HISTORY_LIMIT);
    expect(history.capped).toBe(true);
  });

  it('is not capped when a full read already reaches past the window', () => {
    const full = Array.from({ length: PASSPORT_HISTORY_LIMIT }, (_, i) => completion(i * 10 + 1));
    const history = passportHistory(full, plant, { fullNames: false, now: NOW });
    if (history.status !== 'ok') throw new Error('expected ok');
    expect(history.capped).toBe(false);
  });

  it('tells a plant added inside the window apart from one with no recent care', () => {
    const young = passportHistory([], { createdAt: daysAgo(6) }, { fullNames: false, now: NOW });
    const old = passportHistory([], { createdAt: daysAgo(400) }, { fullNames: false, now: NOW });
    expect(young).toMatchObject({ status: 'ok', entries: [], addedWithinWindow: true });
    expect(old).toMatchObject({ status: 'ok', entries: [], addedWithinWindow: false });
  });

  it('uses the same ceiling as GET /plants/{plantId}/history', () => {
    // The backend default is what production returns. If it moves, the
    // "may be cut short" statement has to move with it.
    const source = readFileSync(
      resolve(process.cwd(), '..', 'backend/src/services/taskService.ts'),
      'utf8'
    );
    const signature = source.match(
      /export async function getTaskCompletions\(\s*householdId: string,\s*plantId: string,\s*limit = (\d+)\s*\)/
    );
    expect(signature, 'getTaskCompletions signature').not.toBeNull();
    expect(Number(signature![1])).toBe(PASSPORT_HISTORY_LIMIT);
  });
});

describe('passportSchedule', () => {
  it('lists intervals and seasons, and carries no task notes or due dates', () => {
    const schedule = passportSchedule({
      upcomingTasks: [
        {
          id: 't1',
          plantId: 'p1',
          plantName: 'Monstera',
          type: 'water',
          frequency: 7,
          seasonalCadences: [{ season: 'winter', frequency: 14 }],
          lastCompleted: null,
          nextDue: '2026-09-20T00:00:00.000Z',
          assignedTo: 'u1',
          assignedToName: 'Chelsea Kelly-Reif',
          notes: SECRET_NOTE,
          createdBy: 'u1',
          createdAt: '',
        },
        {
          id: 't2',
          plantId: 'p1',
          plantName: 'Monstera',
          type: 'custom',
          customType: '  Mist the aerial roots ',
          frequency: 3,
          lastCompleted: null,
          nextDue: '2026-09-20T00:00:00.000Z',
          assignedTo: null,
          assignedToName: null,
          notes: null,
          createdBy: 'u1',
          createdAt: '',
        },
      ],
    });
    expect(schedule).toEqual([
      {
        id: 't1',
        type: 'water',
        customType: null,
        frequency: 7,
        seasonal: [{ season: 'winter', frequency: 14 }],
      },
      { id: 't2', type: 'custom', customType: 'Mist the aerial roots', frequency: 3, seasonal: [] },
    ]);
    expect(JSON.stringify(schedule)).not.toContain(SECRET_NOTE);
    expect(JSON.stringify(schedule)).not.toContain('Chelsea');
  });
});

describe('passportPetSafety — the curated table, species first', () => {
  it('tries the species before the display name', async () => {
    const queries: string[] = [];
    const result = await passportPetSafety(
      { name: 'Kitchen friend', species: 'Epipremnum aureum' },
      async (q) => {
        queries.push(q);
        return q === 'Epipremnum aureum' ? [{ slug: 'pothos' }] : [];
      }
    );
    expect(queries).toEqual(['Epipremnum aureum']);
    expect(result).toEqual({ match: { slug: 'pothos' }, matchedOn: 'Epipremnum aureum' });
  });

  it('falls back to the name, and says what it matched on', async () => {
    const result = await passportPetSafety({ name: 'Monstera', species: null }, async (q) =>
      q === 'Monstera' ? [{ slug: 'monstera' }] : []
    );
    expect(result).toEqual({ match: { slug: 'monstera' }, matchedOn: 'Monstera' });
  });

  it('is null — no claim either way — when the table has no entry', async () => {
    expect(
      await passportPetSafety({ name: 'Mystery cutting', species: 'Unknownus' }, async () => [])
    ).toBeNull();
  });

  it('lets a failed lookup fail, so the page can say it could not check', async () => {
    await expect(
      passportPetSafety({ name: 'Monstera', species: null }, async () => {
        throw new Error('503');
      })
    ).rejects.toThrow('503');
  });
});
