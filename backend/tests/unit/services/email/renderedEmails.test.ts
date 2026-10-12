/**
 * Every email the shared template renders, rendered.
 *
 * Three things, for each builder in each language:
 *
 *   1. The HTML and text parts are written to `backend/test-output/email/`
 *      (git-ignored) so a person can open them, and
 *      `scripts/email-previews.mjs` can screenshot them in light and dark
 *      mode (`npm run email:preview -w backend`).
 *   2. `checkEmailHtml` finds no problem: table layout, inline styles, the
 *      one brand image with alt text and dimensions, no scripts, no remote
 *      CSS, no web fonts, dark-mode rules, http(s) links on our origins only,
 *      every link present in BOTH parts, and under the size cap.
 *      `emailHtmlChecks.test.ts` is the negative control for that checker.
 *   3. The daily reminder is compared to a committed golden in each
 *      language, so a change to its markup is a visible diff in review.
 *
 * `FRONTEND_URL` is the production origin here on purpose: the brief for
 * this work asks for the logo at a stable public path on
 * familygreenhouse.net, and that is what the goldens show.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkEmailHtml, EMAIL_MAX_BYTES } from '../../../support/emailHtmlChecks.js';

const ORIGIN = 'https://familygreenhouse.net';
const API = 'https://api.familygreenhouse.net';
const ORIGINAL_ENV = { ...process.env };
process.env.FRONTEND_URL = ORIGIN;
process.env.PUBLIC_API_URL = API;
process.env.ASSETS_BASE_URL = `${ORIGIN}/assets`;

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '..', '..', '..', '..', 'test-output', 'email');
const GOLDENS = join(HERE, '__goldens__');

// Imported after the environment is set: the builders read FRONTEND_URL at
// call time, but the module graph is large and this keeps the order obvious.
const { composeWelcomeEmail } = await import('../../../../src/services/welcomeEmail.js');
const { composeDigestEmail } = await import('../../../../src/services/digestReport.js');
const { composeRecapEmail } = await import('../../../../src/services/digest.js');
const { composeReminderMessage } = await import('../../../../src/services/reminderEmail.js');
type DigestReport = import('../../../../src/services/digestReport.js').DigestReport;
type ReminderEmailInput = import('../../../../src/services/reminderEmail.js').ReminderEmailInput;
type EmailLocale = import('../../../../src/services/email/catalog.js').EmailLocale;

const UNSUBSCRIBE = `${API}/notifications/email/unsubscribe?t=tok`;

function digestReport(): DigestReport {
  const rowBase = {
    taskType: 'water' as const,
    customLabel: null,
    assignedTo: null,
    assignedToName: null,
    scheduledIntervalDays: 7,
    seasonalCadences: null,
  };
  return {
    householdId: 'hh',
    householdName: 'The Kim House',
    atRisk: {
      status: 'ok',
      rows: [
        {
          ...rowBase,
          plantId: 'p1',
          plantName: 'Monstera',
          taskId: 't1',
          daysOverdue: 6,
          unclaimed: true,
        },
        {
          ...rowBase,
          plantId: 'p2',
          plantName: 'Fiddle Leaf Fig',
          taskId: 't2',
          daysOverdue: 2,
          unclaimed: false,
          assignedTo: 'u2',
          assignedToName: 'Sam',
          taskType: 'fertilize',
        },
        {
          ...rowBase,
          plantId: 'p3',
          plantName: 'Pothos',
          taskId: 't3',
          daysOverdue: 0,
          unclaimed: false,
          assignedTo: 'u1',
          assignedToName: 'Ada',
        },
      ],
      onTrack: 11,
      orphanTasks: 0,
    },
    lastCare: new Map([
      ['p1', { status: 'ok', byUserId: 'u1', byName: 'Ada', daysAgo: 13 }],
      ['p2', { status: 'none' }],
      ['p3', { status: 'unavailable' }],
    ]),
    weather: {
      status: 'ok',
      tips: ['Rain is expected this week, so outdoor plants may need less water.'],
    },
    trend: { status: 'ok', last7: 9, prev7: 6 },
    pets: { status: 'ok', warnings: [{ plantId: 'p3', plantName: 'Pothos', pets: 'cats' }] },
    drift: {
      status: 'ok',
      finding: {
        plantId: 'p2',
        plantName: 'Fiddle Leaf Fig',
        taskId: 't2',
        taskType: 'fertilize',
        customLabel: null,
        actualIntervalDays: 10,
        scheduledIntervalDays: 7,
      },
    },
    awayUserIds: new Set(['u2']),
    coverage: new Map([['u2', { coverName: 'Ada', awayName: 'Sam' }]]),
  };
}

function reminderInput(locale: EmailLocale): ReminderEmailInput {
  const task = (en: string, es: string) => (locale === 'es' ? es : en);
  const plant = (id: string) => `${ORIGIN}/plants/${id}`;
  return {
    locale,
    timeZone: 'America/Los_Angeles',
    restingCount: 2,
    restingAfterDays: 14,
    replyHint: true,
    covering: [{ name: 'Sam', awayUntil: '2026-06-09T12:00:00.000Z' }],
    climate: { status: 'read', rain: true, frostLowC: 2 },
    rows: [
      {
        plantName: 'Monstera',
        taskLabel: task('water', 'regar'),
        due: { kind: 'overdue', days: 6 },
        upForGrabs: false,
        url: plant('p1'),
        taskId: 't1',
      },
      {
        plantName: 'Fiddle Leaf Fig',
        taskLabel: task('fertilize', 'abonar'),
        due: { kind: 'overdue', days: 2 },
        upForGrabs: false,
        url: plant('p2'),
        taskId: 't2',
      },
      {
        plantName: 'Pothos',
        taskLabel: task('water', 'regar'),
        due: { kind: 'today' },
        upForGrabs: false,
        url: plant('p3'),
        taskId: 't3',
      },
      {
        plantName: 'Calathea',
        taskLabel: task('mist', 'nebulizar'),
        due: { kind: 'today' },
        upForGrabs: false,
        url: plant('p4'),
        taskId: 't4',
      },
      {
        plantName: 'Snake Plant',
        taskLabel: task('water', 'regar'),
        due: { kind: 'upcoming' },
        upForGrabs: false,
        url: plant('p5'),
        taskId: 't5',
      },
      {
        plantName: 'Fern',
        taskLabel: null,
        due: { kind: 'unknown' },
        upForGrabs: false,
        url: plant('p6'),
        taskId: 't6',
      },
      {
        plantName: 'Peace Lily',
        taskLabel: task('repot', 'trasplantar'),
        due: { kind: 'overdue', days: 1 },
        upForGrabs: false,
        url: plant('p7'),
        taskId: 't7',
      },
      {
        plantName: 'Jade',
        taskLabel: task('prune', 'podar'),
        due: { kind: 'overdue', days: 3 },
        upForGrabs: true,
        url: plant('p8'),
        taskId: 't8',
      },
      {
        plantName: 'Basil',
        taskLabel: task('water', 'regar'),
        due: { kind: 'today' },
        upForGrabs: true,
        url: plant('p9'),
        taskId: 't9',
      },
    ],
  };
}

interface Rendered {
  subject: string;
  text: string;
  html: string;
}

const CASES: Array<{ name: string; golden: boolean; render: (locale: EmailLocale) => Rendered }> = [
  {
    name: 'welcome',
    golden: false,
    render: (locale) => composeWelcomeEmail('Ada', ORIGIN, locale),
  },
  {
    name: 'digest',
    golden: false,
    render: (locale) =>
      composeDigestEmail(digestReport(), {
        userId: 'u1',
        name: 'Ada',
        locale,
        unsubscribeUrl: UNSUBSCRIBE,
      }),
  },
  {
    name: 'recap',
    golden: false,
    render: (locale) =>
      composeRecapEmail(
        {
          year: 2025,
          totalCompletions: 412,
          byMember: [
            { userId: 'u1', name: 'Ada', count: 260 },
            { userId: 'u2', name: 'Sam', count: 152 },
          ],
          byTaskType: [
            { type: 'water', count: 300 },
            { type: 'fertilize', count: 80 },
            { type: 'prune', count: 32 },
          ],
          topPlants: [
            { plantId: 'p1', count: 120 },
            { plantId: 'p2', count: 90 },
          ],
        },
        {
          status: 'ok',
          names: new Map([
            ['p1', 'Monstera'],
            ['p2', 'Fiddle Leaf Fig'],
          ]),
        },
        { name: 'Ada', locale, unsubscribeUrl: UNSUBSCRIBE },
        'The Kim House'
      ),
  },
  {
    name: 'reminder',
    golden: true,
    render: (locale) => {
      const message = composeReminderMessage(reminderInput(locale), {
        householdName: 'The Kim House',
        tasksUrl: `${ORIGIN}/tasks?filter=due`,
        settingsUrl: `${ORIGIN}/settings?section=notifications`,
      });
      return { subject: message.emailSubject, text: message.text, html: message.html };
    },
  },
];

const sizes: Record<string, number> = {};

beforeAll(() => {
  mkdirSync(OUT_DIR, { recursive: true });
});

afterAll(() => {
  writeFileSync(join(OUT_DIR, 'sizes.json'), `${JSON.stringify(sizes, null, 2)}\n`);
  process.env = ORIGINAL_ENV;
});

describe('every rendered email', () => {
  for (const { name, golden, render } of CASES) {
    for (const locale of ['en', 'es'] as const) {
      const id = `${name}.${locale}`;

      it(`${id}: renders, is valid email HTML, carries every link in both parts, and fits`, async () => {
        const { subject, text, html } = render(locale);
        writeFileSync(join(OUT_DIR, `${id}.html`), html);
        writeFileSync(join(OUT_DIR, `${id}.txt`), `Subject: ${subject}\n\n${text}`);
        sizes[id] = Buffer.byteLength(html, 'utf8');

        expect(checkEmailHtml(html, { origin: ORIGIN, allowedOrigins: [API], text })).toEqual([]);
        expect(sizes[id]).toBeLessThan(EMAIL_MAX_BYTES);
        expect(html).toContain(`<html lang="${locale}"`);
        expect(html).toContain(`src="${ORIGIN}/brand/logo-dark.png"`);
        expect(subject.length).toBeGreaterThan(0);
        expect(subject.length).toBeLessThanOrEqual(90);

        if (golden) {
          await expect(html).toMatchFileSnapshot(join(GOLDENS, `${id}.html`));
          await expect(text).toMatchFileSnapshot(join(GOLDENS, `${id}.txt`));
        }
      });
    }
  }
});
