/**
 * The branded reminder email (`reminderEmail.composeReminderMessage`): the
 * title that says what to do, the grouped rows with a button each, the capped
 * list that links to the rest, and the two MIME parts that cannot disagree.
 *
 * `reminderEmail.test.ts` covers the text composition these are built on;
 * this file covers only what the HTML message adds.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  composeReminderMessage,
  MAX_LISTED_ASSIGNED,
  MAX_LISTED_UNCLAIMED,
  REMINDER_LOCALES,
  __testing,
  type ReminderEmailInput,
  type ReminderMessageContext,
  type ReminderTaskRow,
} from '../../../src/services/reminderEmail.js';
import { REMINDER_EMAIL_COPY, capitalizeFirst } from '../../../src/services/reminderEmailCopy.js';
import { checkEmailHtml } from '../../support/emailHtmlChecks.js';

const ORIGIN = 'https://familygreenhouse.net';
const ORIGINAL_ENV = { ...process.env };

// The logo in the header is built from FRONTEND_URL; the rendering checks
// below require it on the same origin as every link.
beforeAll(() => {
  process.env.FRONTEND_URL = ORIGIN;
});
afterAll(() => {
  process.env = ORIGINAL_ENV;
});

function row(over: Partial<ReminderTaskRow> = {}): ReminderTaskRow {
  return {
    plantName: 'Monstera',
    taskLabel: 'water',
    due: { kind: 'overdue', days: 2 },
    upForGrabs: false,
    url: `${ORIGIN}/plants/p1`,
    taskId: 't1',
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
    restingCount: 0,
    restingAfterDays: 14,
    ...over,
  };
}

const context: ReminderMessageContext = {
  householdName: 'The Kim House',
  tasksUrl: `${ORIGIN}/tasks?filter=due`,
  settingsUrl: `${ORIGIN}/settings?section=notifications`,
};

const titleOf = (html: string) => /<title>([^<]*)<\/title>/u.exec(html)?.[1];

describe('composeReminderMessage — the title says what to do', () => {
  it('names the most urgent plant and its task, with "today" only when nothing is late', () => {
    const late = composeReminderMessage(input(), context);
    expect(late.emailSubject).toBe('Water Monstera');
    const today = composeReminderMessage(
      input({ rows: [row({ due: { kind: 'today' } })] }),
      context
    );
    expect(today.emailSubject).toBe('Water Monstera today');
    expect(titleOf(today.html)).toBe('Water Monstera today');
    expect(today.html).toContain('>Water Monstera today</td>');
  });

  it('counts the rest truthfully, from the complete list and not the capped one', () => {
    const rows = Array.from({ length: MAX_LISTED_ASSIGNED + 3 }, (_, i) =>
      row({
        plantName: i === 0 ? 'Monstera' : `Plant ${i}`,
        taskId: `t${i}`,
        due: { kind: 'today' },
      })
    );
    const { emailSubject } = composeReminderMessage(input({ rows }), context);
    expect(emailSubject).toBe(`Water Monstera and ${MAX_LISTED_ASSIGNED + 2} more today`);
  });

  it('drops "today" from a mixed list the moment one row is overdue', () => {
    const rows = [
      row({ due: { kind: 'overdue', days: 1 } }),
      row({ plantName: 'Fern', due: { kind: 'today' } }),
    ];
    expect(composeReminderMessage(input({ rows }), context).emailSubject).toBe(
      'Water Monstera and 1 more'
    );
  });

  it('uses the household’s own wording for a custom task and "Care for" when there is none', () => {
    const custom = composeReminderMessage(
      input({ rows: [row({ taskLabel: 'mist', due: { kind: 'today' } })] }),
      context
    );
    expect(custom.emailSubject).toBe('Mist Monstera today');
    const unnamed = composeReminderMessage(input({ rows: [row({ taskLabel: null })] }), context);
    expect(unnamed.emailSubject).toBe('Care for Monstera');
  });

  it('falls back to a count when the most urgent plant’s name could not be read', () => {
    const one = composeReminderMessage(input({ rows: [row({ plantName: null })] }), context);
    expect(one.emailSubject).toBe('1 plant needs care');
    const three = composeReminderMessage(
      input({
        rows: [
          row({ plantName: null, due: { kind: 'today' } }),
          row({ due: { kind: 'today' } }),
          row({ due: { kind: 'upcoming' } }),
        ],
      }),
      context
    );
    expect(three.emailSubject).toBe('3 plants need care today');
    expect(three.emailSubject).not.toMatch(/couldn/);
  });

  it('keeps the counts sentence as the inbox preview, so subject and preview do not repeat', () => {
    const { html, subject } = composeReminderMessage(
      input({
        rows: [row(), row({ plantName: 'Fern', due: { kind: 'today' }, upForGrabs: true })],
      }),
      context
    );
    expect(subject).toBe(
      'Plant care reminder: 1 overdue and 1 due today, including 1 nobody has claimed'
    );
    expect(html).toContain('1 overdue and 1 due today, including 1 nobody has claimed.');
  });

  it('says it in Spanish', () => {
    const es = (rows: ReminderTaskRow[]) =>
      composeReminderMessage(input({ rows, locale: 'es' }), context).emailSubject;
    expect(es([row({ taskLabel: 'regar', due: { kind: 'today' } })])).toBe('Regar Monstera hoy');
    expect(
      es([row({ taskLabel: 'regar' }), row({ taskLabel: 'abonar', plantName: 'Helecho' })])
    ).toBe('Regar Monstera y 1 más');
    expect(es([row({ taskLabel: null })])).toBe('Cuidar Monstera');
    expect(es([row({ plantName: null, due: { kind: 'today' } })])).toBe(
      '1 planta necesita cuidados hoy'
    );
    expect(es([row({ plantName: null }), row()])).toBe('2 plantas necesitan cuidados');
  });
});

describe('composeReminderMessage — rows', () => {
  it('groups assigned rows by state under headings that ask rather than scold', () => {
    const { html } = composeReminderMessage(
      input({
        rows: [
          row({ plantName: 'Late', due: { kind: 'overdue', days: 6 } }),
          row({ plantName: 'Now', due: { kind: 'today' } }),
          row({ plantName: 'Soon', due: { kind: 'upcoming' } }),
          row({ plantName: 'Unread', due: { kind: 'unknown' } }),
        ],
      }),
      context
    );
    const at = (s: string) => html.indexOf(s);
    expect(at('Ready for some catch-up care')).toBeGreaterThan(-1);
    expect(at('Ready for some catch-up care')).toBeLessThan(at('>Late<'));
    expect(at('>Late<')).toBeLessThan(at('Due today'));
    expect(at('Due today')).toBeLessThan(at('>Now<'));
    expect(at('>Now<')).toBeLessThan(at('Coming up'));
    expect(at('Coming up')).toBeLessThan(at('>Soon<'));
    // An unreadable due date is its own group, last, under an instruction.
    expect(at('Check the due date')).toBeGreaterThan(at('>Soon<'));
    expect(at('>Unread<')).toBeGreaterThan(at('Check the due date'));
    expect(html).toContain('due date could not be read');
    expect(html.match(/Ready for some catch-up care/g)).toHaveLength(1);
    expect(html).not.toMatch(/overdue by|you forgot|neglect/i);
  });

  it('omits a heading when its group is empty, and never prints an empty section', () => {
    const { html } = composeReminderMessage(
      input({ rows: [row({ due: { kind: 'today' } })] }),
      context
    );
    expect(html).not.toContain('Ready for some catch-up care');
    expect(html).not.toContain('Coming up');
    expect(html).not.toContain('Up for grabs');
    expect(html).toContain('Due today');
  });

  it('gives every row its plant, its task and due phrase, and a button to the plant', () => {
    const { html } = composeReminderMessage(
      input({ rows: [row({ due: { kind: 'overdue', days: 6 } })] }),
      context
    );
    expect(html).toContain(`href="${ORIGIN}/plants/p1"`);
    expect(html).toContain('Water · 6 days overdue');
    expect(html).toContain('Mark done in the app');
    // The button is a link to the plant, where the task is marked done.
    expect(html.match(new RegExp(`href="${ORIGIN}/plants/p1"`, 'g'))).toHaveLength(2);
  });

  it('puts unclaimed rows in their own section with the claim note', () => {
    const { html } = composeReminderMessage(
      input({
        rows: [row(), row({ plantName: 'Free', url: `${ORIGIN}/plants/p2`, upForGrabs: true })],
      }),
      context
    );
    expect(html).toContain('Up for grabs');
    expect(html).toContain(
      'Nobody has claimed these yet, so anyone in the household can take them.'
    );
    expect(html.indexOf('>Free<')).toBeGreaterThan(html.indexOf('Up for grabs'));
  });

  it('states the true remainder of a capped section as a link to the full list', () => {
    const assigned = Array.from({ length: MAX_LISTED_ASSIGNED + 2 }, (_, i) =>
      row({ plantName: `Own ${i}`, taskId: `a${i}`, url: `${ORIGIN}/plants/a${i}` })
    );
    const unclaimed = Array.from({ length: MAX_LISTED_UNCLAIMED + 1 }, (_, i) =>
      row({
        plantName: `Free ${i}`,
        taskId: `f${i}`,
        url: `${ORIGIN}/plants/f${i}`,
        upForGrabs: true,
      })
    );
    const { html, text } = composeReminderMessage(
      input({ rows: [...assigned, ...unclaimed] }),
      context
    );
    expect(html).toContain('>and 2 more</a>');
    expect(html).toContain('>and 1 more</a>');
    expect(
      html.match(new RegExp(`href="${ORIGIN}/tasks\\?filter=due"`, 'g'))!.length
    ).toBeGreaterThanOrEqual(3);
    expect(html).not.toContain(`Own ${MAX_LISTED_ASSIGNED}`);
    expect(html).not.toContain(`Free ${MAX_LISTED_UNCLAIMED}`);
    // The text part keeps its own true-total sentence.
    expect(text).toContain(`Showing ${MAX_LISTED_ASSIGNED} of ${MAX_LISTED_ASSIGNED + 2}.`);
  });

  it('numbers the HTML rows exactly as the text numbers them when a reply address is bound', () => {
    const rows = [
      row({ plantName: 'Own A', taskId: 'a' }),
      row({ plantName: 'Own B', taskId: 'b', due: { kind: 'today' } }),
      row({ plantName: 'Free C', taskId: 'c', upForGrabs: true }),
    ];
    const { html, text, listed } = composeReminderMessage(
      input({ rows, replyHint: true }),
      context
    );
    expect(listed.map((r) => r.taskId)).toEqual(['a', 'b', 'c']);
    expect(html).toContain('>1. Own A<');
    expect(html).toContain('>2. Own B<');
    expect(html).toContain('>3. Free C<');
    expect(text).toContain('1. Own A — water, 2 days overdue');
    expect(text).toContain('3. Free C — water, 2 days overdue');
    expect(html).toContain('Reply to this email with &quot;done 1&quot;');

    const plain = composeReminderMessage(input({ rows }), context);
    expect(plain.html).not.toContain('>1. Own A<');
    expect(plain.html).toContain('>Own A<');
    expect(plain.html).not.toContain('Reply to this email');
  });

  it('carries the aged-out note, the cover note and the weather under their own heading', () => {
    const { html } = composeReminderMessage(
      input({
        restingCount: 2,
        covering: [{ name: 'Sam', awayUntil: '2026-06-09T00:00:00.000Z' }],
        climate: { status: 'read', rain: true, frostLowC: 2 },
      }),
      context
    );
    expect(html).toContain('2 more tasks have been waiting 14 days or longer.');
    expect(html).toContain('covering for Sam, who is away until June 9, 2026');
    expect(html).toContain('Outside today');
    expect(html).toContain('Rain is forecast for your area');
    expect(html).toContain('A low of 2°C is forecast tonight');
  });

  it('says nothing about the weather when the forecast could not be read', () => {
    const { html } = composeReminderMessage(input(), context);
    expect(html).not.toContain('Outside today');
    expect(html).not.toMatch(/rain|frost/i);
  });

  it('escapes a markup-shaped plant name in the HTML and keeps it verbatim in the text', () => {
    const evil = '<script>alert(1)</script>Ficus';
    const { html, text } = composeReminderMessage(
      input({ rows: [row({ plantName: evil })] }),
      context
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;Ficus');
    expect(text).toContain(evil);
  });
});

describe('composeReminderMessage — the two parts and the footer', () => {
  it('names the household in the footer, with a settings link, and falls back honestly', () => {
    const named = composeReminderMessage(input(), context);
    expect(named.html).toContain('daily plant-care reminders are on for you in The Kim House');
    expect(named.html).toContain(`href="${ORIGIN}/settings?section=notifications"`);
    expect(named.html).toContain('Reminder settings');
    expect(named.html).toContain('will never ask for your password');
    expect(named.text).toContain(`Reminder settings: ${ORIGIN}/settings?section=notifications`);

    const unnamed = composeReminderMessage(input(), { ...context, householdName: null });
    expect(unnamed.html).toContain(
      'daily plant-care reminders are on for you on Family Greenhouse'
    );
    expect(unnamed.html).not.toContain('The Kim House');
  });

  it('uses the tested text composition as the text part, under the title and over the footer', () => {
    const { text, body, emailSubject } = composeReminderMessage(input(), context);
    expect(text.startsWith(`${emailSubject}\n${'='.repeat(emailSubject.length)}\n\n`)).toBe(true);
    expect(text).toContain(body);
    expect(text).toContain(`\n\n${ORIGIN}/tasks?filter=due\n`);
    expect(text).toContain('--\nYou are getting this because');
  });

  it('keeps the push and SMS fields exactly as the text composition makes them', () => {
    const { subject, body, shortBody } = composeReminderMessage(input(), context);
    expect(subject).toBe('Plant care reminder: 1 overdue');
    expect(shortBody).toBe('1 overdue');
    expect(body).toContain('1. Monstera — water, 2 days overdue');
  });

  it('passes the rendering checks in both languages, with every link in both parts', () => {
    for (const locale of REMINDER_LOCALES) {
      const { html, text } = composeReminderMessage(
        input({
          locale,
          replyHint: true,
          rows: [
            row(),
            row({ plantName: 'Free', url: `${ORIGIN}/plants/p2`, taskId: 't2', upForGrabs: true }),
          ],
          climate: { status: 'read', rain: true, frostLowC: null },
          restingCount: 1,
        }),
        context
      );
      expect(checkEmailHtml(html, { origin: ORIGIN, text }), locale).toEqual([]);
      expect(html).toContain(`<html lang="${locale}"`);
    }
  });
});

describe('reminderEmailCopy', () => {
  it('both locales carry exactly the same keys', () => {
    const en = Object.keys(REMINDER_EMAIL_COPY.en).sort();
    for (const locale of REMINDER_LOCALES) {
      expect(Object.keys(REMINDER_EMAIL_COPY[locale]).sort(), locale).toEqual(en);
    }
  });

  it('has no Spanish string byte-identical to its English source', () => {
    const en = REMINDER_EMAIL_COPY.en;
    const es = REMINDER_EMAIL_COPY.es;
    const identical = (Object.keys(en) as Array<keyof typeof en>).filter((key) => {
      const a = en[key];
      const b = es[key];
      if (typeof a === 'string') return a === b;
      // Functions: compare on one representative call.
      const args = ['Water', 'Monstera', '2', true] as const;
      return (
        (a as (...x: unknown[]) => string)(...args) === (b as (...x: unknown[]) => string)(...args)
      );
    });
    expect(identical).toEqual([]);
  });

  it('capitalizes only the first letter, per locale', () => {
    expect(capitalizeFirst('water', 'en')).toBe('Water');
    expect(capitalizeFirst('regar', 'es')).toBe('Regar');
    expect(capitalizeFirst('bottom-water ONLY', 'en')).toBe('Bottom-water ONLY');
    expect(capitalizeFirst('', 'en')).toBe('');
  });

  it('exposes the title builder for the end-to-end suite', () => {
    expect(__testing.emailTitle([row({ due: { kind: 'today' } })], 'en')).toBe(
      'Water Monstera today'
    );
  });
});
