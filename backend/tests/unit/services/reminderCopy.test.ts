/**
 * The short form of a reminder (`services/reminderCopy.ts`): what a push
 * notification says. Both languages, one task and several, due today against
 * overdue, the two-name cap, and the privacy rule — rendered from a fixture
 * that carries every private field the product stores, none of which may
 * appear.
 */
import { describe, expect, it } from 'vitest';
import {
  composeReminderShortCopy,
  reminderActionCopy,
  NAMED_ROWS,
  __testing,
  type ReminderCopyRow,
} from '../../../src/services/reminderCopy.js';
import { REMINDER_LOCALES, type ReminderLocale } from '../../../src/services/reminderEmail.js';

function row(over: Partial<ReminderCopyRow> = {}): ReminderCopyRow {
  return {
    plantName: 'Monstera',
    taskLabel: 'water',
    taskType: 'water',
    due: { kind: 'today' },
    upForGrabs: false,
    ...over,
  };
}

describe('one task', () => {
  it('titles the action and the plant, and says when and what happens next (en)', () => {
    const copy = composeReminderShortCopy({ rows: [row()], locale: 'en' });
    expect(copy.title).toBe('Water the Monstera');
    expect(copy.body).toBe('Due today. Mark it done once you have, or snooze it until tomorrow.');
    expect(copy.kind).toBe('single');
    expect(copy.actions).toEqual({ done: 'Done', snoozeUntilTomorrow: 'Snooze until tomorrow' });
  });

  it('is written as Spanish, not translated word for word (es)', () => {
    const copy = composeReminderShortCopy({
      rows: [row({ taskLabel: 'regar' })],
      locale: 'es',
    });
    // No article: the household chose the name, and its gender is unknown.
    expect(copy.title).toBe('Monstera necesita riego');
    expect(copy.body).toBe(
      'Toca hoy. Márcala como hecha cuando la hagas, o pospónla hasta mañana.'
    );
    expect(copy.actions).toEqual({ done: 'Hecho', snoozeUntilTomorrow: 'Posponer hasta mañana' });
  });

  it.each([
    ['fertilize', 'Fertilize the Monstera', 'Monstera necesita abono'],
    ['prune', 'Prune the Monstera', 'Monstera necesita poda'],
    ['repot', 'Repot the Monstera', 'Monstera necesita trasplante'],
  ] as const)('names the %s action in both languages', (taskType, en, es) => {
    expect(composeReminderShortCopy({ rows: [row({ taskType })], locale: 'en' }).title).toBe(en);
    expect(composeReminderShortCopy({ rows: [row({ taskType })], locale: 'es' }).title).toBe(es);
  });

  it('keeps the household wording for a custom task, plant first', () => {
    const rows = [row({ taskType: 'custom', taskLabel: 'Mist the leaves' })];
    expect(composeReminderShortCopy({ rows, locale: 'en' }).title).toBe(
      'Monstera: Mist the leaves'
    );
    expect(composeReminderShortCopy({ rows, locale: 'es' }).title).toBe(
      'Monstera: Mist the leaves'
    );
  });

  it('distinguishes overdue from due today as a date, not a verdict', () => {
    const yesterday = composeReminderShortCopy({
      rows: [row({ due: { kind: 'overdue', days: 1 } })],
      locale: 'en',
    });
    expect(yesterday.body.startsWith('Due yesterday.')).toBe(true);
    const older = composeReminderShortCopy({
      rows: [row({ due: { kind: 'overdue', days: 3 } })],
      locale: 'en',
    });
    expect(older.body.startsWith('Due 3 days ago.')).toBe(true);
    expect(older.body).not.toMatch(/overdue/i);
    expect(older.body).not.toMatch(/!/);
    const later = composeReminderShortCopy({
      rows: [row({ due: { kind: 'upcoming' } })],
      locale: 'en',
    });
    expect(later.body.startsWith('Due later today.')).toBe(true);

    expect(
      composeReminderShortCopy({ rows: [row({ due: { kind: 'overdue', days: 1 } })], locale: 'es' })
        .body
    ).toMatch(/^Tocaba ayer\./);
    expect(
      composeReminderShortCopy({ rows: [row({ due: { kind: 'overdue', days: 3 } })], locale: 'es' })
        .body
    ).toMatch(/^Tocaba hace 3 días\./);
  });

  it('says the due date could not be read rather than guessing one', () => {
    const copy = composeReminderShortCopy({
      rows: [row({ due: { kind: 'unknown' } })],
      locale: 'en',
    });
    expect(copy.body).toContain('We could not read its due date');
    expect(copy.body).not.toMatch(/NaN|undefined|null/);
  });

  it('says when nobody has claimed the task', () => {
    const copy = composeReminderShortCopy({ rows: [row({ upForGrabs: true })], locale: 'en' });
    expect(copy.body).toBe(
      'Due today. Nobody has claimed it yet, so anyone can. Mark it done once you have, or snooze it until tomorrow.'
    );
  });

  it('renders a failed name read as the email does, never as a blank or a fallback name', () => {
    const en = composeReminderShortCopy({ rows: [row({ plantName: null })], locale: 'en' });
    expect(en.title).toBe("Water a plant whose name we couldn't load");
    const es = composeReminderShortCopy({ rows: [row({ plantName: null })], locale: 'es' });
    expect(es.title).toBe('Una planta cuyo nombre no pudimos cargar necesita riego');
    const unnamedTask = composeReminderShortCopy({
      rows: [row({ taskType: 'custom', taskLabel: null })],
      locale: 'en',
    });
    expect(unnamedTask.title).toBe('Monstera: unnamed care task');
    expect(unnamedTask.title).not.toContain('custom');
  });
});

describe('several tasks', () => {
  const fern = row({ plantName: 'Fern', due: { kind: 'overdue', days: 2 } });
  const ficus = row({ plantName: 'Ficus', taskType: 'fertilize', taskLabel: 'fertilize' });

  it('counts plants that all need the same thing', () => {
    const copy = composeReminderShortCopy({ rows: [fern, row()], locale: 'en' });
    expect(copy.title).toBe('2 plants need water');
    expect(copy.body).toBe('Fern and Monstera. 1 overdue and 1 due today. Tap to see the list.');
    expect(copy.kind).toBe('several');
    expect(copy.actions).toBeNull();
  });

  it('counts plants that need different things', () => {
    const copy = composeReminderShortCopy({ rows: [fern, ficus], locale: 'en' });
    expect(copy.title).toBe('2 plants need care');
  });

  it('names the plant when every task is on it', () => {
    const copy = composeReminderShortCopy({
      rows: [row(), ficus, row({ plantName: 'Ficus' })],
      locale: 'en',
    });
    expect(copy.title).toBe('3 care tasks');
    const onePlant = composeReminderShortCopy({
      rows: [row(), row({ taskType: 'fertilize', taskLabel: 'fertilize' })],
      locale: 'en',
    });
    expect(onePlant.title).toBe('Monstera: 2 care tasks');
    expect(onePlant.body).toBe('Monstera. 2 due today. Tap to see the list.');
  });

  it('names the first two and counts the rest, never a wall', () => {
    const rows = [
      fern,
      row({ plantName: 'Monstera', due: { kind: 'overdue', days: 5 } }),
      row({ plantName: 'Pothos' }),
      row({ plantName: 'Snake Plant' }),
      row({ plantName: 'Calathea', due: { kind: 'unknown' } }),
    ];
    const copy = composeReminderShortCopy({ rows, locale: 'en' });
    expect(NAMED_ROWS).toBe(2);
    expect(copy.title).toBe('5 plants need water');
    expect(copy.body).toBe(
      'Fern and Monstera and 3 more. 2 overdue, 2 due today and 1 with no readable due date. Tap to see the list.'
    );
    expect(copy.body).not.toContain('Pothos');
    expect(copy.body).not.toContain('Calathea');
    expect(copy.body.split('\n')).toHaveLength(1);

    const es = composeReminderShortCopy({ rows, locale: 'es' });
    expect(es.title).toBe('5 plantas necesitan riego');
    expect(es.body).toBe(
      'Fern y Monstera y 3 más. 2 atrasadas, 2 para hoy y 1 sin fecha legible. Toca para ver la lista.'
    );
  });

  it('states how many nobody has claimed', () => {
    const copy = composeReminderShortCopy({
      rows: [fern, row({ upForGrabs: true })],
      locale: 'en',
    });
    expect(copy.body).toContain('Nobody has claimed 1 of them.');
    const es = composeReminderShortCopy({
      rows: [fern, row({ upForGrabs: true })],
      locale: 'es',
    });
    expect(es.body).toContain('Nadie ha tomado 1 de ellas.');
  });

  it('counts a failed name read without printing a blank', () => {
    const copy = composeReminderShortCopy({
      rows: [row({ plantName: null }), fern],
      locale: 'en',
    });
    expect(copy.body.startsWith("A plant whose name we couldn't load and Fern.")).toBe(true);
  });

  it('refuses an empty reminder rather than composing one about nothing', () => {
    expect(() => composeReminderShortCopy({ rows: [], locale: 'en' })).toThrow(/at least one row/);
  });
});

describe('both catalogs', () => {
  it('carry the same keys', () => {
    const [en, es] = REMINDER_LOCALES.map((locale) => __testing.COPY[locale]);
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(es.singleTitle).sort()).toEqual(Object.keys(en.singleTitle).sort());
    expect(Object.keys(es.severalSameType).sort()).toEqual(Object.keys(en.severalSameType).sort());
  });

  it('never leave a Spanish string verbatim English', () => {
    const en = __testing.COPY.en;
    const es = __testing.COPY.es;
    const keys = ['dueToday', 'dueYesterday', 'dueUnknown', 'singleNext', 'severalNext'] as const;
    for (const key of keys) expect(es[key]).not.toBe(en[key]);
    expect(reminderActionCopy('es')).not.toEqual(reminderActionCopy('en'));
  });

  it.each(REMINDER_LOCALES)('format counts with the %s locale', (locale: ReminderLocale) => {
    const rows = Array.from({ length: 1234 }, (_, i) => row({ plantName: `Plant ${i}` }));
    const copy = composeReminderShortCopy({ rows, locale });
    expect(copy.title).toContain(new Intl.NumberFormat(locale).format(1234));
  });
});

/**
 * Rule 5. The fixture is a structural superset of every row the product
 * stores: a plant's notes and care rule, a task's notes, the assignee's name,
 * the member's email and phone. The type does not admit them, so they are
 * attached past the type on purpose: this is the test that would catch the
 * module reaching for a field it should not know about.
 */
describe('privacy', () => {
  const PRIVATE = {
    notes: 'SECRET-NOTE keep away from the window, Sam waters it Tuesdays',
    careRule: 'SECRET-RULE bottom-water only',
    taskNotes: 'SECRET-TASK-NOTE use the blue can',
    assignedToName: 'SECRET-PERSON Sam Example',
    email: 'secret-person@example.com',
    phone: '+15550001111',
  };

  function leakyRow(over: Partial<ReminderCopyRow> = {}): ReminderCopyRow {
    return {
      ...row(over),
      notes: PRIVATE.notes,
      careRule: PRIVATE.careRule,
      taskNotes: PRIVATE.taskNotes,
      assignedToName: PRIVATE.assignedToName,
      email: PRIVATE.email,
      phone: PRIVATE.phone,
    } as ReminderCopyRow;
  }

  it.each(REMINDER_LOCALES)('%s: no private field reaches a title, a body or a label', (locale) => {
    const single = composeReminderShortCopy({ rows: [leakyRow()], locale });
    const several = composeReminderShortCopy({
      rows: [leakyRow(), leakyRow({ plantName: 'Fern' }), leakyRow({ plantName: 'Ficus' })],
      locale,
    });
    for (const rendered of [JSON.stringify(single), JSON.stringify(several)]) {
      for (const value of Object.values(PRIVATE)) {
        expect(rendered).not.toContain(value);
      }
      expect(rendered).not.toContain('SECRET');
    }
  });
});
