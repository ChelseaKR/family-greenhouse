import { describe, it, expect } from 'vitest';
import {
  composeReminderEmail,
  countRows,
  resolveCoveredName,
  taskLabelFor,
  MAX_LISTED_ASSIGNED,
  MAX_LISTED_UNCLAIMED,
  REMINDER_LOCALES,
  __testing,
} from '../../../src/services/reminderEmail.js';
import type {
  ReminderTaskRow,
  ReminderEmailInput,
  ReminderLocale,
} from '../../../src/services/reminderEmail.js';
import type { HouseholdMember } from '../../../src/models/types.js';

function row(over: Partial<ReminderTaskRow> = {}): ReminderTaskRow {
  return {
    plantName: 'Monstera',
    taskLabel: 'water',
    due: { kind: 'overdue', days: 2 },
    upForGrabs: false,
    url: 'https://familygreenhouse.net/plants/p1',
    ...over,
  };
}

function input(over: Partial<ReminderEmailInput> = {}): ReminderEmailInput {
  return {
    rows: [row()],
    covering: [],
    climate: { status: 'unavailable' },
    locale: 'en',
    timeZone: 'UTC',
    ...over,
  };
}

function member(userId: string, name: string): HouseholdMember {
  return {
    householdId: 'hh',
    userId,
    name,
    email: `${userId}@x.com`,
    role: 'member',
    joinedAt: '',
  };
}

describe('reminderEmail — list rendering', () => {
  it('names every plant and task and deep-links each row to its own plant', () => {
    const { body } = composeReminderEmail(
      input({
        rows: [
          row({
            plantName: 'Monstera',
            taskLabel: 'water',
            due: { kind: 'overdue', days: 6 },
            url: 'https://familygreenhouse.net/plants/p-monstera',
          }),
          row({
            plantName: 'Fiddle Leaf Fig',
            taskLabel: 'fertilize',
            due: { kind: 'today' },
            url: 'https://familygreenhouse.net/plants/p-fiddle',
          }),
        ],
      })
    );

    expect(body).toContain('1. Monstera — water, 6 days overdue');
    expect(body).toContain('https://familygreenhouse.net/plants/p-monstera');
    expect(body).toContain('2. Fiddle Leaf Fig — fertilize, due today');
    expect(body).toContain('https://familygreenhouse.net/plants/p-fiddle');
    // No row points at the filtered list — that is the footer's job only.
    expect(body).not.toContain('/tasks?filter=due');
  });

  it('renders 1 day overdue in the singular', () => {
    const { body } = composeReminderEmail(
      input({ rows: [row({ due: { kind: 'overdue', days: 1 } })] })
    );
    expect(body).toContain('Monstera — water, 1 day overdue');
  });

  it('puts the subject counts in the subject line, not just a fixed title', () => {
    const { subject } = composeReminderEmail(
      input({
        rows: [
          row({ due: { kind: 'overdue', days: 3 } }),
          row({ due: { kind: 'upcoming' } }),
          row({ due: { kind: 'upcoming' } }),
        ],
      })
    );
    expect(subject).toBe('Plant care reminder: 1 overdue and 2 coming up');
  });
});

describe('reminderEmail — a subset always states the true total', () => {
  it('lists the cap and reports the real number of assigned rows', () => {
    const rows = Array.from({ length: MAX_LISTED_ASSIGNED + 7 }, (_, i) =>
      row({ plantName: `Plant ${i}`, due: { kind: 'overdue', days: 30 - i } })
    );
    const { subject, body } = composeReminderEmail(input({ rows }));

    // The subject counts every row, uncapped — the digest's documented rule:
    // under-reporting reassures precisely the households that need the nudge.
    expect(subject).toContain(`${rows.length} overdue`);
    expect(body).toContain(`Showing ${MAX_LISTED_ASSIGNED} of ${rows.length}.`);
    expect(body).toContain('Plant 0 — water');
    expect(body).not.toContain(`Plant ${MAX_LISTED_ASSIGNED} —`);
  });

  it('caps and totals the up-for-grabs section independently', () => {
    const rows = [
      row({ plantName: 'Mine' }),
      ...Array.from({ length: MAX_LISTED_UNCLAIMED + 3 }, (_, i) =>
        row({ plantName: `Free ${i}`, upForGrabs: true })
      ),
    ];
    const { body } = composeReminderEmail(input({ rows }));
    // A member drowning in their own tasks still sees the claimable ones.
    expect(body).toContain('Mine — water');
    expect(body).toContain(`Showing ${MAX_LISTED_UNCLAIMED} of ${MAX_LISTED_UNCLAIMED + 3}.`);
  });

  it('omits the subset line entirely when nothing is hidden', () => {
    const { body } = composeReminderEmail(input({ rows: [row(), row()] }));
    expect(body).not.toContain('Showing');
  });
});

describe('reminderEmail — honesty fixes', () => {
  it('never prints a zero bucket: all-overdue says nothing about "coming up"', () => {
    const rows = Array.from({ length: 5 }, () => row({ due: { kind: 'overdue', days: 4 } }));
    const { subject, body } = composeReminderEmail(input({ rows }));
    // Was: "5 ready for some catch-up care, 0 coming up soon".
    expect(subject).toBe('Plant care reminder: 5 overdue');
    expect(body).not.toContain('coming up');
    expect(body).not.toMatch(/\b0\b/);
  });

  it('renders a failed member lookup as a failed lookup, not a person named "a housemate"', () => {
    const { body } = composeReminderEmail(
      input({ covering: [{ name: null, awayUntil: '2026-06-05T00:00:00.000Z' }] })
    );
    expect(body).toContain("whose name we couldn't load");
    expect(body).not.toContain('a housemate');
    // And it must not fabricate a covering-for sentence with an empty name.
    expect(body).not.toContain("You're covering for ,");
  });

  it('collapses several unresolved covers into one honest sentence, keeping named ones', () => {
    const { body } = composeReminderEmail(
      input({
        covering: [
          { name: 'Sam', awayUntil: null },
          { name: null, awayUntil: null },
          { name: null, awayUntil: null },
        ],
      })
    );
    expect(body).toContain("You're covering for Sam while they're away.");
    expect(body.match(/whose name we couldn't load/g)).toHaveLength(1);
  });

  it('renders an unreadable due date as unknown, never as NaN or 0 days', () => {
    const { subject, body } = composeReminderEmail(
      input({ rows: [row({ due: { kind: 'unknown' } })] })
    );
    expect(subject).toBe('Plant care reminder: 1 with no readable due date');
    expect(body).toContain('due date could not be read');
    expect(body).not.toContain('NaN');
    expect(body).not.toContain('0 days');
  });

  it('renders a missing plant name as a missing read, never as an empty gap', () => {
    const { body } = composeReminderEmail(input({ rows: [row({ plantName: null })] }));
    expect(body).toContain("a plant whose name we couldn't load — water");
  });

  it('never prints the literal enum value "custom" as a task name', () => {
    expect(taskLabelFor('custom', null, 'en')).toBeNull();
    expect(taskLabelFor('custom', '   ', 'en')).toBeNull();
    expect(taskLabelFor('custom', 'mist', 'en')).toBe('mist');
    const { body } = composeReminderEmail(input({ rows: [row({ taskLabel: null })] }));
    expect(body).toContain('Monstera — unnamed care task');
    expect(body).not.toMatch(/— custom,/);
  });

  it('resolveCoveredName returns null rather than inventing a placeholder', () => {
    const members = [member('u1', 'Sam')];
    expect(resolveCoveredName(members, 'u1', null)).toBe('Sam');
    // Roster row missing, task carries the denormalized name: still a real value.
    expect(resolveCoveredName(members, 'u2', 'Alex')).toBe('Alex');
    // Neither available — the old code returned 'a housemate' here.
    expect(resolveCoveredName(members, 'u2', null)).toBeNull();
    expect(resolveCoveredName(members, 'u2', '  ')).toBeNull();
    expect(resolveCoveredName([member('u3', '  ')], 'u3', null)).toBeNull();
  });
});

describe('reminderEmail — up for grabs', () => {
  it('marks unassigned tasks claimable instead of folding them into a count', () => {
    const { subject, body } = composeReminderEmail(
      input({
        rows: [
          row({ plantName: 'Monstera' }),
          row({ plantName: 'Pothos', upForGrabs: true, due: { kind: 'today' } }),
        ],
      })
    );
    expect(subject).toContain('including 1 nobody has claimed');
    expect(body).toContain('Up for grabs — nobody has claimed these, so anyone can:');
    expect(body).toContain('- Pothos — water, due today');
    // Claimable rows are not mixed into the member's own numbered list.
    expect(body).toContain('1. Monstera — water');
    expect(body).not.toContain('2. Pothos');
  });

  it('counts unclaimed rows as a subset, so the reader cannot double-count', () => {
    const counts = countRows([
      row({ due: { kind: 'overdue', days: 1 } }),
      row({ due: { kind: 'today' }, upForGrabs: true }),
      row({ due: { kind: 'upcoming' }, upForGrabs: true }),
      row({ due: { kind: 'unknown' } }),
    ]);
    expect(counts).toEqual({
      overdue: 1,
      today: 1,
      upcoming: 1,
      unknown: 1,
      unclaimed: 2,
      total: 4,
    });
    expect(counts.overdue + counts.today + counts.upcoming + counts.unknown).toBe(counts.total);
  });

  it('omits the section and the suffix when nothing is unclaimed', () => {
    const { subject, body } = composeReminderEmail(input());
    expect(subject).not.toContain('nobody has claimed');
    expect(body).not.toContain('Up for grabs');
  });
});

describe('reminderEmail — vacation cover', () => {
  it('says who is covered and until when, in the recipient time zone', () => {
    const { body } = composeReminderEmail(
      input({
        covering: [{ name: 'Sam', awayUntil: '2026-09-12T00:00:00.000Z' }],
        timeZone: 'America/Los_Angeles',
      })
    );
    // 2026-09-12T00:00Z is still the 11th in Los Angeles — the recipient's day.
    expect(body).toContain("You're covering for Sam, who is away until September 11, 2026.");
  });

  it('falls back to the undated sentence when the window end is missing', () => {
    const { body } = composeReminderEmail(input({ covering: [{ name: 'Sam', awayUntil: null }] }));
    expect(body).toContain("You're covering for Sam while they're away.");
    expect(body).not.toContain('until');
  });

  it('drops an unparseable end date rather than printing "Invalid Date"', () => {
    const { body } = composeReminderEmail(
      input({ covering: [{ name: 'Sam', awayUntil: 'not-a-date' }] })
    );
    expect(body).toContain("You're covering for Sam while they're away.");
    expect(body).not.toContain('Invalid Date');
    expect(body).not.toContain('NaN');
  });

  it('a corrupt time zone still renders the sentence instead of losing the reminder', () => {
    expect(__testing.formatAwayUntil('2026-09-12T12:00:00.000Z', 'en', 'Nowhere/Fake')).toContain(
      '2026'
    );
  });

  it('lists each covered member on their own line', () => {
    const { body } = composeReminderEmail(
      input({
        covering: [
          { name: 'Sam', awayUntil: '2026-09-12T00:00:00.000Z' },
          { name: 'Alex', awayUntil: null },
        ],
      })
    );
    expect(body).toContain("You're covering for Sam, who is away until September 12, 2026.");
    expect(body).toContain("You're covering for Alex while they're away.");
  });
});

describe('reminderEmail — climate', () => {
  it('says nothing at all when the forecast could not be read', () => {
    const { body } = composeReminderEmail(input({ climate: { status: 'unavailable' } }));
    // Silence, never "no rain expected" — we did not read the weather.
    expect(body).not.toContain('Rain');
    expect(body).not.toContain('rain');
    expect(body).not.toContain('forecast');
  });

  it('adds the rain line when the forecast was read and says rain', () => {
    const { body } = composeReminderEmail(
      input({ climate: { status: 'read', rain: true, frostLowC: null } })
    );
    expect(body).toContain(
      "Rain is forecast for your area — outdoor plants likely don't need watering today."
    );
  });

  it('says nothing when the forecast was read and no signal applies', () => {
    const { body } = composeReminderEmail(
      input({ climate: { status: 'read', rain: false, frostLowC: null } })
    );
    expect(body).not.toContain('forecast');
  });

  it('rounds the frost low and never prints a bare number without units', () => {
    const { body } = composeReminderEmail(
      input({ climate: { status: 'read', rain: false, frostLowC: 2.4 } })
    );
    expect(body).toContain('A low of 2°C is forecast tonight — bring tender plants indoors.');
  });
});

describe('reminderEmail — localization', () => {
  it('both catalogs carry exactly the same keys', () => {
    const keys = (locale: ReminderLocale) => Object.keys(__testing.COPY[locale]).sort();
    expect(keys('es')).toEqual(keys('en'));
    expect(REMINDER_LOCALES).toEqual(['en', 'es']);
  });

  it('renders the whole email in Spanish, including plurals and dates', () => {
    const { subject, body } = composeReminderEmail(
      input({
        locale: 'es',
        rows: [
          row({ plantName: 'Monstera', taskLabel: taskLabelFor('water', null, 'es') }),
          row({
            plantName: 'Poto',
            taskLabel: taskLabelFor('repot', null, 'es'),
            due: { kind: 'today' },
            upForGrabs: true,
          }),
        ],
        covering: [{ name: 'Sam', awayUntil: '2026-09-12T00:00:00.000Z' }],
        climate: { status: 'read', rain: true, frostLowC: null },
      })
    );

    expect(subject).toBe(
      'Recordatorio de cuidado de plantas: 1 atrasada y 1 para hoy, incluida 1 que nadie ha tomado'
    );
    expect(body).toContain('1. Monstera — regar, 2 días de retraso');
    expect(body).toContain('- Poto — trasplantar, para hoy');
    expect(body).toContain('Sin asignar');
    expect(body).toContain(
      'Estás cubriendo a Sam, que está fuera hasta el 12 de septiembre de 2026.'
    );
    expect(body).toContain('Se espera lluvia en tu zona');
    // No English leaked through.
    expect(body).not.toMatch(/overdue|coming up|covering for/);
  });

  it('uses the singular Spanish form for one day overdue', () => {
    const { body } = composeReminderEmail(
      input({ locale: 'es', rows: [row({ due: { kind: 'overdue', days: 1 } })] })
    );
    expect(body).toContain('1 día de retraso');
  });

  it('Spanish suppresses zero buckets too', () => {
    const { subject } = composeReminderEmail(
      input({ locale: 'es', rows: [row({ due: { kind: 'overdue', days: 2 } })] })
    );
    expect(subject).toBe('Recordatorio de cuidado de plantas: 1 atrasada');
    expect(subject).not.toContain('0');
  });
});

describe('reminderEmail — short channels', () => {
  it('shortBody is one line and fits an SMS segment', () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      row({ plantName: `Plant ${i}`, upForGrabs: i % 2 === 0 })
    );
    for (const locale of REMINDER_LOCALES) {
      const { shortBody, subject } = composeReminderEmail(input({ rows, locale }));
      expect(shortBody).not.toContain('\n');
      // SMS is `${title}: ${shortBody}` capped at one 140-byte segment.
      expect(Buffer.byteLength(`${subject}: ${shortBody}`, 'utf8')).toBeLessThan(140);
    }
  });

  it('stays one line even with every bucket populated', () => {
    const rows = [
      ...Array.from({ length: 3 }, () => row({ due: { kind: 'overdue', days: 2 } })),
      row({ due: { kind: 'today' } }),
      row({ due: { kind: 'upcoming' }, upForGrabs: true }),
      row({ due: { kind: 'unknown' } }),
    ];
    for (const locale of REMINDER_LOCALES) {
      const { shortBody } = composeReminderEmail(input({ rows, locale }));
      expect(shortBody).not.toContain('\n');
      // Every non-zero bucket is named, and no zero bucket is.
      expect(shortBody).toMatch(/3/);
      expect(shortBody).not.toMatch(/\b0\b/);
    }
  });

  it('falls back to the bare title when there is nothing to summarise', () => {
    expect(composeReminderEmail(input({ rows: [] })).shortBody).toBe('Plant care reminder');
    expect(composeReminderEmail(input({ rows: [], locale: 'es' })).shortBody).toBe(
      'Recordatorio de cuidado de plantas'
    );
  });
});
