import { describe, it, expect } from 'vitest';
import {
  composeCareCreditEmail,
  composeCoverageEmail,
  composeInviteEmail,
  composeMemberJoinedEmail,
  composeUpForGrabsEmail,
  daysUntilDue,
  formatDate,
  normalizeEmailLocale,
  preferredEmailLocale,
  taskLabel,
} from '../../../src/services/emailCopy.js';

const NOW = new Date('2026-09-03T12:00:00.000Z');
const SETTINGS = 'https://app.example.net/settings';

describe('emailCopy locale resolution', () => {
  it('accepts both shipped languages and normalizes regional tags', () => {
    expect(normalizeEmailLocale('es')).toBe('es');
    expect(normalizeEmailLocale('es-MX')).toBe('es');
    expect(normalizeEmailLocale('EN_US')).toBe('en');
  });

  it('falls back to English for a language we do not ship', () => {
    expect(normalizeEmailLocale('fr')).toBe('en');
    expect(normalizeEmailLocale(undefined)).toBe('en');
    expect(normalizeEmailLocale(42)).toBe('en');
  });

  it('reads a stored locale preference when one exists, and defaults when it does not', () => {
    // `NotificationPreferences` has no locale field on main yet; this is the
    // forward-compatible read documented in preferredEmailLocale.
    expect(preferredEmailLocale({ email: true })).toBe('en');
    expect(preferredEmailLocale({ email: true, locale: 'es' })).toBe('es');
    expect(preferredEmailLocale(null)).toBe('en');
  });
});

describe('emailCopy formatting primitives', () => {
  it('formats dates through Intl in the recipient language', () => {
    expect(formatDate('2026-09-10T00:00:00.000Z', 'en')).toBe('September 10, 2026');
    expect(formatDate('2026-09-10T00:00:00.000Z', 'es')).toContain('2026');
    expect(formatDate('2026-09-10T00:00:00.000Z', 'es')).not.toBe(
      formatDate('2026-09-10T00:00:00.000Z', 'en')
    );
  });

  it('returns null rather than "Invalid Date" for an unusable timestamp', () => {
    expect(formatDate('not-a-date', 'en')).toBeNull();
    expect(formatDate('', 'es')).toBeNull();
  });

  it('never produces NaN days from a malformed due date', () => {
    // The weekly digest renders `waiting NaN days for some care` here.
    expect(daysUntilDue('garbage', NOW)).toBeNull();
    expect(daysUntilDue('2026-09-06T12:00:00.000Z', NOW)).toBe(3);
    expect(daysUntilDue('2026-09-01T12:00:00.000Z', NOW)).toBe(0);
  });

  it('never prints the internal enum value for an unnamed custom task', () => {
    // The digest prints the literal string `custom` when customType is null.
    expect(taskLabel({ type: 'custom', customType: null }, 'en')).toBe('a care task');
    expect(taskLabel({ type: 'custom', customType: null }, 'es')).toBe('una tarea de cuidado');
    expect(taskLabel({ type: 'custom', customType: 'wipe leaves' }, 'es')).toBe('wipe leaves');
    expect(taskLabel({ type: 'water', customType: null }, 'es')).toBe('regar');
  });
});

describe('composeInviteEmail', () => {
  const input = {
    inviterName: 'Sam',
    householdName: 'The Kim House',
    joinUrl: 'https://app.example.net/join/abc',
    expiresAt: '2026-09-10T00:00:00.000Z',
  };

  it('names the sender and the household in the subject, in both languages', () => {
    expect(composeInviteEmail(input, 'en').subject).toContain('Sam');
    expect(composeInviteEmail(input, 'en').subject).toContain('The Kim House');
    expect(composeInviteEmail(input, 'es').subject).toContain('Sam');
    expect(composeInviteEmail(input, 'es').subject).toContain('The Kim House');
  });

  it('says what accepting means, when the link dies, and how to ignore it', () => {
    const { text } = composeInviteEmail(input, 'en');
    expect(text).toContain('https://app.example.net/join/abc');
    expect(text).toContain('September 10, 2026');
    expect(text).toMatch(/care history/i);
    expect(text).toMatch(/ignore this email/i);
    expect(text).toMatch(/leave whenever/i);
  });

  it('is genuinely Spanish, not the English body with a Spanish subject', () => {
    const es = composeInviteEmail(input, 'es').text;
    expect(es).toContain('te ha invitado');
    expect(es).toContain('ignora este correo');
    expect(es).not.toMatch(/Accept the invitation/);
  });

  it('falls back to the seven-day phrasing when the expiry is unusable', () => {
    const { text } = composeInviteEmail({ ...input, expiresAt: 'nonsense' }, 'en');
    expect(text).toContain('seven days');
    expect(text).not.toContain('Invalid Date');
    expect(text).not.toContain('NaN');
  });
});

describe('composeMemberJoinedEmail', () => {
  const base = {
    householdName: 'The Kim House',
    recipientSentTheInvite: false,
    householdUrl: 'https://app.example.net/household',
    settingsUrl: SETTINGS,
  };

  it('names the person who joined and the household', () => {
    const { subject, text } = composeMemberJoinedEmail({ ...base, memberName: 'Priya' }, 'en');
    expect(subject).toBe('Priya joined The Kim House');
    expect(text).toContain('Priya accepted the invitation');
    expect(text).toContain('https://app.example.net/household');
  });

  it('thanks the inviter only when the recipient is the inviter', () => {
    const withCredit = composeMemberJoinedEmail(
      { ...base, memberName: 'Priya', recipientSentTheInvite: true },
      'en'
    );
    expect(withCredit.text).toContain('You sent that invitation');
    const without = composeMemberJoinedEmail({ ...base, memberName: 'Priya' }, 'en');
    expect(without.text).not.toContain('You sent that invitation');
  });

  it('says the name is missing rather than inventing "a housemate"', () => {
    const { subject, text } = composeMemberJoinedEmail({ ...base, memberName: null }, 'en');
    expect(subject).toBe('Someone joined your household');
    expect(text).toContain("We couldn't load their name");
    expect(text).not.toMatch(/a housemate/i);
    expect(text).not.toContain('null');
    expect(text).not.toContain('undefined');
  });

  it('says "your household" when the household name could not be read', () => {
    const { text } = composeMemberJoinedEmail(
      { ...base, memberName: 'Priya', householdName: null },
      'en'
    );
    expect(text).toContain('your household');
    expect(text).not.toContain('null');
  });

  it('renders the unknown-name case in Spanish too', () => {
    const { text } = composeMemberJoinedEmail({ ...base, memberName: null }, 'es');
    expect(text).toContain('No hemos podido leer su nombre');
  });
});

describe('composeUpForGrabsEmail', () => {
  const task = {
    plantName: 'Monstera',
    taskLabel: 'water',
    daysUntilDue: 4,
    plantUrl: 'https://app.example.net/plants/p1',
  };
  const base = {
    householdName: 'The Kim House',
    claimUrl: 'https://app.example.net/tasks?filter=overdue',
    settingsUrl: SETTINGS,
  };

  it('names the plant and the task and links to the plant', () => {
    const { text } = composeUpForGrabsEmail({ ...base, tasks: [task], totalCount: 1 }, 'en');
    expect(text).toContain('Monstera — water (in 4 days)');
    expect(text).toContain('https://app.example.net/plants/p1');
    expect(text).toContain('https://app.example.net/tasks?filter=overdue');
  });

  it('is forward-looking — it never claims anything is late', () => {
    // Everything at or inside the daily reminder's 24h window belongs to the
    // reminder (PR #427), so this email is only ever about what is coming.
    const { subject, text } = composeUpForGrabsEmail(
      { ...base, tasks: [task], totalCount: 1 },
      'en'
    );
    expect(subject).toBe('One task next week has nobody on it');
    expect(text).toContain('comes up in the next week and nobody has claimed it yet');
    expect(text).toContain('None of this is late yet');
    expect(text).not.toMatch(/days overdue|has been overdue/i);
  });

  it('reports the real total even when it lists fewer', () => {
    // The digest's own docstring records what happens when a display cap
    // becomes the reported count.
    const { subject, text } = composeUpForGrabsEmail(
      { ...base, tasks: [task], totalCount: 9 },
      'en'
    );
    expect(subject).toContain('9 tasks');
    expect(text).toContain('And 8 more.');
  });

  it('makes it explicit that nobody in particular is being asked', () => {
    const { text } = composeUpForGrabsEmail({ ...base, tasks: [task], totalCount: 1 }, 'en');
    expect(text).toMatch(/went to the whole household, not just you/);
  });

  it('says tomorrow rather than "in 1 days" at the near edge', () => {
    const { text } = composeUpForGrabsEmail(
      { ...base, tasks: [{ ...task, daysUntilDue: 1 }], totalCount: 1 },
      'en'
    );
    expect(text).toContain('(tomorrow)');
    expect(text).not.toContain('in 1 days');
  });

  it('admits an unreadable due date instead of guessing at it', () => {
    const { text } = composeUpForGrabsEmail(
      { ...base, tasks: [{ ...task, daysUntilDue: null }], totalCount: 1 },
      'en'
    );
    expect(text).toContain("(we couldn't read the date)");
    expect(text).not.toContain('NaN');
    expect(text).not.toContain('null');
  });

  it('has a Spanish body', () => {
    const { subject, text } = composeUpForGrabsEmail(
      { ...base, tasks: [task], totalCount: 1 },
      'es'
    );
    expect(subject).toBe('Una tarea de la próxima semana no tiene dueño');
    expect(text).toContain('todavía no la tiene nadie');
    expect(text).toContain('(en 4 días)');
    expect(text).toContain('Nada de esto va con retraso todavía');
  });
});

describe('composeCoverageEmail', () => {
  const base = {
    awayName: 'Alex',
    householdName: 'The Kim House',
    startDate: '2026-09-05T00:00:00.000Z',
    endDate: '2026-09-12T00:00:00.000Z',
    tasksUrl: 'https://app.example.net/tasks',
    settingsUrl: SETTINGS,
  };
  const scheduled = [
    {
      plantName: 'Fiddle Leaf Fig',
      taskLabel: 'water',
      dueDate: '2026-09-07T00:00:00.000Z',
      plantUrl: 'https://app.example.net/plants/p2',
    },
  ];

  it('names who is away, the dates, and the tasks', () => {
    const { subject, text } = composeCoverageEmail({ ...base, tasks: scheduled }, 'en');
    expect(subject).toBe("Alex is away — you're covering their plants");
    expect(text).toContain('September 5, 2026');
    expect(text).toContain('September 12, 2026');
    expect(text).toContain('Fiddle Leaf Fig — water');
    expect(text).toContain('https://app.example.net/plants/p2');
  });

  it('distinguishes "the list did not load" from "the list is empty"', () => {
    const unreadable = composeCoverageEmail({ ...base, tasks: null }, 'en').text;
    expect(unreadable).toContain("We couldn't load the task list");
    expect(unreadable).not.toMatch(/none of their tasks/i);

    const empty = composeCoverageEmail({ ...base, tasks: [] }, 'en').text;
    expect(empty).toMatch(/none of their tasks fall inside those dates/i);
    expect(empty).not.toContain("couldn't load");
  });

  it('does not name a cover subject it could not read', () => {
    const { subject, text } = composeCoverageEmail({ ...base, awayName: null, tasks: [] }, 'en');
    expect(subject).toBe("You're covering someone's plants while they're away");
    expect(text).toContain("We couldn't load their name");
    expect(text).not.toMatch(/\ba housemate\b/i);
  });

  it('survives an unusable due date without printing Invalid Date', () => {
    const { text } = composeCoverageEmail(
      { ...base, tasks: [{ ...scheduled[0], dueDate: 'oops' }] },
      'en'
    );
    expect(text).toContain('date unavailable');
    expect(text).not.toContain('Invalid Date');
  });

  it('has a Spanish body including the unreadable-list case', () => {
    expect(composeCoverageEmail({ ...base, tasks: scheduled }, 'es').text).toContain(
      'Lo que hay previsto'
    );
    expect(composeCoverageEmail({ ...base, tasks: null }, 'es').text).toContain(
      'No hemos podido cargar la lista'
    );
  });
});

describe('composeCareCreditEmail', () => {
  const item = {
    plantName: 'Monstera',
    taskLabel: 'water',
    actorName: 'Sam',
    note: 'soil was bone dry',
    plantUrl: 'https://app.example.net/plants/p1',
  };
  const base = {
    moreCount: 0,
    activityUrl: 'https://app.example.net/dashboard',
    settingsUrl: SETTINGS,
  };

  it('names the person who helped and quotes their note', () => {
    const { subject, text } = composeCareCreditEmail({ ...base, items: [item] }, 'en');
    expect(subject).toBe('Sam covered for you');
    expect(text).toContain('Sam — Monstera · water');
    expect(text).toContain('soil was bone dry');
  });

  it('is not a scoreboard: no counts per person, no ranking, nothing asked of the reader', () => {
    const { subject, text } = composeCareCreditEmail(
      {
        ...base,
        items: [item, { ...item, actorName: 'Alex', plantName: 'Pothos', note: null }],
      },
      'en'
    );
    expect(subject).toBe('Sam and Alex covered for you');
    expect(text).toContain('Sam and Alex did tasks that had your name on them');
    // No "Sam: 2" style tallies anywhere.
    expect(text).not.toMatch(/Sam:\s*\d/);
    expect(text).not.toMatch(/\bleaderboard\b|\branked?\b|\bmost\b|\bfewest\b/i);
    expect(text).toContain("There's nothing for you to do");
  });

  it('counts overflow truthfully instead of quietly truncating', () => {
    const { text } = composeCareCreditEmail({ ...base, items: [item], moreCount: 3 }, 'en');
    expect(text).toContain('And 3 more tasks.');
  });

  it('acknowledges an unreadable actor rather than naming a stand-in', () => {
    const { subject, text } = composeCareCreditEmail(
      { ...base, items: [{ ...item, actorName: null }] },
      'en'
    );
    expect(subject).toBe('Someone covered a task of yours');
    expect(text).toContain("we couldn't load who");
    expect(text).not.toMatch(/\ba housemate\b/i);
  });

  it('flags the mixed case where one actor is known and another is not', () => {
    const { text } = composeCareCreditEmail(
      { ...base, items: [item, { ...item, actorName: null }] },
      'en'
    );
    expect(text).toContain("We couldn't load who did one of them");
  });

  it('has a Spanish body', () => {
    const { subject, text } = composeCareCreditEmail({ ...base, items: [item] }, 'es');
    expect(subject).toBe('Sam se ocupó de tus plantas');
    expect(text).toContain('No hay nada que tengas que hacer');
  });
});

describe('every household email carries a way to turn it off', () => {
  it('ends with the settings link in both languages', () => {
    const bodies = [
      composeMemberJoinedEmail(
        {
          memberName: 'Priya',
          householdName: 'H',
          recipientSentTheInvite: false,
          householdUrl: 'u',
          settingsUrl: SETTINGS,
        },
        'en'
      ),
      composeUpForGrabsEmail(
        {
          householdName: 'H',
          tasks: [],
          totalCount: 1,
          claimUrl: 'u',
          settingsUrl: SETTINGS,
        },
        'es'
      ),
      composeCoverageEmail(
        {
          awayName: 'A',
          householdName: 'H',
          startDate: '2026-09-05T00:00:00.000Z',
          endDate: '2026-09-12T00:00:00.000Z',
          tasks: [],
          tasksUrl: 'u',
          settingsUrl: SETTINGS,
        },
        'en'
      ),
      composeCareCreditEmail(
        {
          items: [
            {
              plantName: 'P',
              taskLabel: 'water',
              actorName: 'S',
              note: null,
              plantUrl: 'u',
            },
          ],
          moreCount: 0,
          activityUrl: 'u',
          settingsUrl: SETTINGS,
        },
        'es'
      ),
    ];
    for (const body of bodies) {
      expect(body.text).toContain(SETTINGS);
    }
  });
});
