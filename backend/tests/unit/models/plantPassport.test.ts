/**
 * The plant passport's frozen summary and first note (#676).
 *
 * The rules under test are the ones that make a link safe to hand a stranger:
 * a summary the server built holds nothing but the fields the schema names,
 * a stored block that is anything else reads as "no passport", every absence
 * is stated as an absence, and the note that lands in the recipient's
 * household is composed from the summary and the card alone.
 */
import { describe, expect, it } from 'vitest';
import {
  PASSPORT_COMPLETIONS_READ,
  PASSPORT_IMPORT_MAX_BODY_BYTES,
  PASSPORT_MAX_SCHEDULE,
  PASSPORT_NOTE_MAX_LENGTH,
  buildPassportSummary,
  composePassportNote,
  parsePassportSummary,
  passportImportBodySchema,
  passportImportEnabled,
  passportSummarySchema,
  type PassportSummary,
} from '../../../src/models/plantPassport.js';

const NOW = new Date('2026-09-19T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();

function summaryOf(overrides: Partial<Parameters<typeof buildPassportSummary>[0]> = {}) {
  return buildPassportSummary({
    plant: { createdAt: daysAgo(400), speciesSource: 'catalog' },
    tasks: [{ type: 'water', customType: null, frequency: 7, seasonalCadences: null }],
    completions: [{ completedAt: daysAgo(3) }, { completedAt: daysAgo(10) }],
    completionsReadLimit: PASSPORT_COMPLETIONS_READ,
    lineage: { parentName: null, cuttingsTaken: 0 },
    now: NOW,
    ...overrides,
  });
}

function noteOf(summary: PassportSummary, overrides: Record<string, unknown> = {}) {
  return composePassportNote({
    summary,
    careRule: 'Bottom-water only',
    species: 'Monstera deliciosa',
    householdName: 'The Reyes house',
    sharedOn: '2026-09-19',
    locale: 'en',
    ...overrides,
  });
}

describe('passportImportEnabled', () => {
  it('is off unless PASSPORT_IMPORT_ENABLED is exactly "1"', () => {
    const before = process.env.PASSPORT_IMPORT_ENABLED;
    try {
      delete process.env.PASSPORT_IMPORT_ENABLED;
      expect(passportImportEnabled()).toBe(false);
      for (const value of ['', '0', 'true', 'yes', ' 1']) {
        process.env.PASSPORT_IMPORT_ENABLED = value;
        expect(passportImportEnabled()).toBe(false);
      }
      process.env.PASSPORT_IMPORT_ENABLED = '1';
      expect(passportImportEnabled()).toBe(true);
    } finally {
      if (before === undefined) delete process.env.PASSPORT_IMPORT_ENABLED;
      else process.env.PASSPORT_IMPORT_ENABLED = before;
    }
  });
});

describe('buildPassportSummary', () => {
  it('reads only the fields the summary has a place for', () => {
    // Every private thing a plant, a task and a completion can hold, on the
    // inputs. None of it may appear in the output: the builder copies field by
    // field and the schema is strict.
    const summary = buildPassportSummary({
      plant: {
        createdAt: daysAgo(400),
        speciesSource: 'identified',
        // @ts-expect-error — not part of the input type, and must never be read.
        notes: 'PRIVATE-PLANT-NOTE',
        householdId: 'hh-secret',
        id: 'plant-secret',
      },
      tasks: [
        {
          type: 'custom',
          customType: 'Mist the fronds',
          frequency: 3,
          // @ts-expect-error — as above.
          notes: 'PRIVATE-TASK-NOTE',
          assignedTo: 'user-secret',
          assignedToName: 'Secret Person',
          seasonalCadences: [{ season: 'winter', frequency: 10 }],
        },
      ],
      completions: [
        {
          completedAt: daysAgo(2),
          // @ts-expect-error — as above.
          notes: 'PRIVATE-COMPLETION-NOTE',
          completedByName: 'Secret Person',
          completedBy: 'user-secret',
        },
      ],
      completionsReadLimit: PASSPORT_COMPLETIONS_READ,
      lineage: { parentName: 'Kitchen Pothos', cuttingsTaken: 2 },
      now: NOW,
    });

    const json = JSON.stringify(summary);
    for (const secret of [
      'PRIVATE-PLANT-NOTE',
      'PRIVATE-TASK-NOTE',
      'PRIVATE-COMPLETION-NOTE',
      'Secret Person',
      'user-secret',
      'hh-secret',
      'plant-secret',
    ]) {
      expect(json).not.toContain(secret);
    }
    expect(summary.schedule).toEqual([
      {
        type: 'custom',
        customType: 'Mist the fronds',
        frequency: 3,
        seasonal: [{ season: 'winter', frequency: 10 }],
      },
    ]);
    expect(summary.speciesSource).toBe('identified');
    expect(summary.lineage).toEqual({ parentName: 'Kitchen Pothos', cuttingsTaken: 2 });
  });

  it('counts only care inside the window and dates the newest entry', () => {
    const summary = summaryOf({
      completions: [
        { completedAt: daysAgo(2) },
        { completedAt: daysAgo(30) },
        { completedAt: daysAgo(89) },
        { completedAt: daysAgo(120) },
      ],
    });
    expect(summary.care).toEqual({
      windowDays: 90,
      loggedInWindow: 3,
      atLeast: false,
      addedWithinWindow: false,
      lastLoggedOn: daysAgo(2).slice(0, 10),
    });
  });

  it('says "at least" when the read came back full and still reached into the window', () => {
    const completions = Array.from({ length: PASSPORT_COMPLETIONS_READ }, (_, i) => ({
      completedAt: daysAgo(i % 80),
    }));
    const summary = summaryOf({ completions });
    expect(summary.care.loggedInWindow).toBe(PASSPORT_COMPLETIONS_READ);
    expect(summary.care.atLeast).toBe(true);
  });

  it('does not call a full read a floor when its oldest entry fell outside the window', () => {
    const completions = [
      ...Array.from({ length: 10 }, (_, i) => ({ completedAt: daysAgo(i) })),
      ...Array.from({ length: PASSPORT_COMPLETIONS_READ - 10 }, (_, i) => ({
        completedAt: daysAgo(100 + i),
      })),
    ];
    const summary = summaryOf({ completions });
    expect(summary.care.loggedInWindow).toBe(10);
    expect(summary.care.atLeast).toBe(false);
  });

  it('marks a plant added inside the window, so an empty log is "not yet"', () => {
    const summary = summaryOf({
      plant: { createdAt: daysAgo(5), speciesSource: null },
      completions: [],
    });
    expect(summary.care).toMatchObject({
      loggedInWindow: 0,
      addedWithinWindow: true,
      lastLoggedOn: null,
    });
    expect(summary.inHouseholdSince).toBe(daysAgo(5).slice(0, 10));
  });

  it('caps the schedule and states how many tasks were left off', () => {
    const tasks = Array.from({ length: PASSPORT_MAX_SCHEDULE + 3 }, () => ({
      type: 'water' as const,
      customType: null,
      frequency: 7,
    }));
    const summary = summaryOf({ tasks });
    expect(summary.schedule).toHaveLength(PASSPORT_MAX_SCHEDULE);
    expect(summary.scheduleMore).toBe(3);
  });

  it('cleans a custom task name and drops it when nothing is left', () => {
    const summary = summaryOf({
      tasks: [
        { type: 'custom', customType: '  Mist\n\tthe\u0000  fronds ', frequency: 2 },
        { type: 'custom', customType: '   ', frequency: 2 },
        { type: 'water', customType: 'ignored for a standard task', frequency: 2 },
      ],
    });
    expect(summary.schedule.map((s) => s.customType)).toEqual(['Mist the fronds', null, null]);
  });

  it('never yields something its own schema would refuse', () => {
    expect(passportSummarySchema.safeParse(summaryOf()).success).toBe(true);
  });
});

describe('parsePassportSummary — a stored block is untrusted', () => {
  const good = summaryOf();

  it('accepts exactly a summary', () => {
    expect(parsePassportSummary(good)).toEqual(good);
  });

  it('reads absent as no passport', () => {
    expect(parsePassportSummary(undefined)).toBeNull();
    expect(parsePassportSummary(null)).toBeNull();
  });

  it.each([
    ['a string', 'not a summary'],
    ['an array', []],
    ['a number', 7],
    ['an empty object', {}],
    ['a wrong version', { ...good, version: 2 }],
    ['a bad date', { ...good, inHouseholdSince: 'yesterday' }],
    ['a zero interval', { ...good, schedule: [{ ...good.schedule[0], frequency: 0 }] }],
    ['an interval over a year', { ...good, schedule: [{ ...good.schedule[0], frequency: 366 }] }],
    ['an unknown task type', { ...good, schedule: [{ ...good.schedule[0], type: 'exorcise' }] }],
    ['a negative count', { ...good, lineage: { ...good.lineage, cuttingsTaken: -1 } }],
    ['a non-integer count', { ...good, care: { ...good.care, loggedInWindow: 1.5 } }],
    ['a count past the read', { ...good, care: { ...good.care, loggedInWindow: 101 } }],
    ['a different window', { ...good, care: { ...good.care, windowDays: 30 } }],
  ])('rejects %s', (_label, value) => {
    expect(parsePassportSummary(value)).toBeNull();
  });

  it.each([
    ['plant notes', { notes: 'PRIVATE' }],
    ['a household id', { householdId: 'hh-other' }],
    ['a plant id', { plantId: 'plant-other' }],
    ['a token', { token: 'secret-token' }],
    ['a Stripe identifier', { stripeCustomerId: 'cus_123' }],
  ])('refuses an unknown top-level key: %s', (_label, extra) => {
    expect(parsePassportSummary({ ...good, ...extra })).toBeNull();
  });

  it('refuses an unknown key nested in every object the summary has', () => {
    expect(parsePassportSummary({ ...good, care: { ...good.care, notes: 'PRIVATE' } })).toBeNull();
    expect(
      parsePassportSummary({ ...good, lineage: { ...good.lineage, parentId: 'p-1' } })
    ).toBeNull();
    expect(
      parsePassportSummary({
        ...good,
        schedule: [{ ...good.schedule[0], assignedTo: 'user-1' }],
      })
    ).toBeNull();
    expect(
      parsePassportSummary({
        ...good,
        schedule: [
          { ...good.schedule[0], seasonal: [{ season: 'winter', frequency: 9, notes: 'x' }] },
        ],
      })
    ).toBeNull();
  });

  it('refuses oversize: too many tasks, a long custom name, a long parent name', () => {
    const tooMany = Array.from({ length: PASSPORT_MAX_SCHEDULE + 1 }, () => good.schedule[0]);
    expect(parsePassportSummary({ ...good, schedule: tooMany })).toBeNull();
    expect(
      parsePassportSummary({
        ...good,
        schedule: [{ ...good.schedule[0], type: 'custom', customType: 'x'.repeat(51) }],
      })
    ).toBeNull();
    expect(
      parsePassportSummary({ ...good, lineage: { ...good.lineage, parentName: 'x'.repeat(101) } })
    ).toBeNull();
  });

  it('bounds the whole: a summary with every field at its cap is still small', () => {
    const heaviest = {
      ...good,
      schedule: Array.from({ length: PASSPORT_MAX_SCHEDULE }, () => ({
        type: 'custom',
        customType: 'x'.repeat(50),
        frequency: 365,
        seasonal: ['spring', 'summer', 'autumn', 'winter'].map((season) => ({
          season,
          frequency: 365,
        })),
      })),
      scheduleMore: 10_000,
      care: { ...good.care, loggedInWindow: PASSPORT_COMPLETIONS_READ },
      lineage: { parentName: 'y'.repeat(100), cuttingsTaken: 10_000 },
    };
    expect(parsePassportSummary(heaviest)).not.toBeNull();
    expect(JSON.stringify(heaviest).length).toBeLessThan(3072);
  });

  it('refuses more than four seasonal cadences', () => {
    const five = Array.from({ length: 5 }, () => ({ season: 'winter', frequency: 9 }));
    expect(
      parsePassportSummary({ ...good, schedule: [{ ...good.schedule[0], seasonal: five }] })
    ).toBeNull();
  });
});

describe('passportImportBodySchema — the import takes no body', () => {
  it('accepts nothing and the empty object', () => {
    expect(passportImportBodySchema.safeParse(undefined).success).toBe(true);
    expect(passportImportBodySchema.safeParse(null).success).toBe(true);
    expect(passportImportBodySchema.safeParse({}).success).toBe(true);
  });

  it.each([
    ['a forged household', { householdId: 'hh-victim' }],
    ['a forged plant', { plantId: 'plant-victim' }],
    ['a note', { notes: 'hello' }],
    ['a summary', { passport: {} }],
  ])('refuses %s', (_label, body) => {
    expect(passportImportBodySchema.safeParse(body).success).toBe(false);
  });

  it('refuses a non-object body', () => {
    for (const body of ['x', 7, true, []]) {
      expect(passportImportBodySchema.safeParse(body).success).toBe(false);
    }
  });

  it('has a body budget far below the framework default', () => {
    expect(PASSPORT_IMPORT_MAX_BODY_BYTES).toBeLessThanOrEqual(1024);
  });
});

describe('composePassportNote', () => {
  it('composes the note from the summary and the card, and nothing else', () => {
    const note = noteOf(
      summaryOf({
        tasks: [
          {
            type: 'water',
            customType: null,
            frequency: 7,
            seasonalCadences: [
              { season: 'summer', frequency: 4 },
              { season: 'winter', frequency: 14 },
            ],
          },
          { type: 'fertilize', customType: null, frequency: 30 },
        ],
        lineage: { parentName: 'Kitchen Pothos', cuttingsTaken: 2 },
      })
    );
    expect(note).toContain('Plant passport from The Reyes house, shared on 2026-09-19.');
    expect(note).toContain('House rule: Bottom-water only');
    expect(note).toContain('Water every 7 days (summer 4, winter 14); Fertilize every 30 days');
    expect(note).toContain('2 care entries in the last 90 days, most recent');
    expect(note).toContain(
      'Lineage: a cutting of Kitchen Pothos; 2 cuttings have been taken from it.'
    );
    expect(note).toContain('picked from the plant catalog');
  });

  it('states every absence instead of omitting it', () => {
    const note = noteOf(
      summaryOf({
        plant: { createdAt: daysAgo(3), speciesSource: null },
        tasks: [],
        completions: [],
      }),
      { careRule: null, species: null }
    );
    expect(note).toContain('House rule: none was written for this plant.');
    expect(note).toContain('Care schedule: none was set for this plant.');
    expect(note).toContain('no care has been logged since this plant was added on');
    expect(note).toContain('Lineage: no parent plant or cuttings are recorded.');
    // No species on the card: no provenance claim about a species.
    expect(note).not.toContain('Species as that household recorded it');
  });

  it('tells an old plant with an empty window apart from a new one', () => {
    const old = noteOf(summaryOf({ completions: [{ completedAt: daysAgo(200) }] }));
    expect(old).toContain('no care was logged in the last 90 days. Last logged care: ');
    const older = noteOf(summaryOf({ completions: [] }));
    expect(older).toContain('no care was logged in the last 90 days.');
    expect(older).not.toContain('Last logged care');
    expect(older).not.toContain('since this plant was added');
  });

  it('says "at least" for a full read and never presents the ceiling as a count', () => {
    const completions = Array.from({ length: PASSPORT_COMPLETIONS_READ }, (_, i) => ({
      completedAt: daysAgo(i % 80),
    }));
    expect(noteOf(summaryOf({ completions }))).toContain(
      `at least ${PASSPORT_COMPLETIONS_READ} care entries in the last 90 days`
    );
  });

  it('flags a photo-identified species as a guess', () => {
    const note = noteOf(
      summaryOf({ plant: { createdAt: daysAgo(400), speciesSource: 'identified' } })
    );
    expect(note).toContain('suggested from a photo, so treat it as a guess');
  });

  it('never carries the household name past a line break or control character', () => {
    const note = noteOf(summaryOf(), { householdName: 'Evil\nHouse\u0000 <script>' });
    expect(note.split('\n')[0]).toBe(
      'Plant passport from Evil House <script>, shared on 2026-09-19.'
    );
  });

  it('stays within the plant-note cap however much it is given', () => {
    const tasks = Array.from({ length: PASSPORT_MAX_SCHEDULE }, () => ({
      type: 'custom' as const,
      customType: 'z'.repeat(50),
      frequency: 365,
      seasonalCadences: (['spring', 'summer', 'autumn', 'winter'] as const).map((season) => ({
        season,
        frequency: 365,
      })),
    }));
    const note = noteOf(
      summaryOf({ tasks, lineage: { parentName: 'p'.repeat(100), cuttingsTaken: 500 } }),
      { careRule: 'r'.repeat(140), householdName: 'h'.repeat(100) }
    );
    expect(note.length).toBeLessThanOrEqual(PASSPORT_NOTE_MAX_LENGTH);
  });

  it('is written in Spanish for a Spanish speaker, with the same absences stated', () => {
    const note = noteOf(
      summaryOf({
        plant: { createdAt: daysAgo(3), speciesSource: 'user' },
        tasks: [{ type: 'water', customType: null, frequency: 1 }],
        completions: [],
        lineage: { parentName: null, cuttingsTaken: 1 },
      }),
      { locale: 'es', careRule: null }
    );
    expect(note).toContain('Pasaporte de planta de The Reyes house, compartido el 2026-09-19.');
    expect(note).toContain('Regla de la casa: no se escribió ninguna para esta planta.');
    expect(note).toContain('Regar cada día');
    expect(note).toContain('no se ha registrado ningún cuidado desde que se añadió esta planta');
    expect(note).toContain('Linaje: se ha sacado 1 esqueje de ella.');
    // No English left over.
    expect(note).not.toMatch(/House rule|Care log|Lineage|every \d/);
  });
});
