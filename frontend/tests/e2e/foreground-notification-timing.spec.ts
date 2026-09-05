import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { provisionAccount, uiLogin, type ProvisionedAccount } from './helpers';

const API_URL = 'http://localhost:4000';
const APP_ORIGIN = 'http://localhost:3000';
const CALLS_KEY = 'fg.e2e.foregroundNotificationCalls';

interface CapturedNotification {
  title: string;
  body?: string;
  tag?: string;
}

/**
 * The fixture clock, and the two instants that hang off it.
 *
 * `useOverdueAlerts` classifies by calendar day (`isOverdue`) and wakes at the
 * instant a task turns overdue (`overdueAt` — local midnight after the due
 * day). Under the instant rule it replaced, a task due at 09:00 alerted at
 * 09:00 while every surface in the app still labelled it "Today" (#591), so a
 * task due seconds from now no longer becomes overdue seconds from now: the
 * only transition that exists happens at local midnight, and no test can wait
 * for it in real time. Playwright's clock supplies it instead — the tab starts
 * ten minutes before local midnight and jumps across the boundary once.
 *
 * `startsAt` is on the runner's own calendar day so the whole fixture is one
 * short hop from real time: nothing in the app sees a date months adrift.
 * `dueAt` is 09:00 that same day — already past as an instant, still "Today"
 * as a calendar day, which is exactly the pair #591 was about.
 */
function fixtureClock(): { startsAt: Date; dueAt: Date; turnsOverdueAt: Date } {
  const startsAt = new Date();
  startsAt.setHours(23, 50, 0, 0);

  const dueAt = new Date(startsAt);
  dueAt.setHours(9, 0, 0, 0);

  // Mirrors `utils/date`'s `overdueAt`, deliberately spelled out rather than
  // imported: the fixture has to state the boundary independently of the
  // production helper it is checking.
  const turnsOverdueAt = new Date(dueAt);
  turnsOverdueAt.setHours(0, 0, 0, 0);
  turnsOverdueAt.setDate(turnsOverdueAt.getDate() + 1);

  return { startsAt, dueAt, turnsOverdueAt };
}

async function loginToken(
  request: APIRequestContext,
  account: ProvisionedAccount
): Promise<string> {
  const login = await request.post(`${API_URL}/auth/login`, {
    data: { email: account.email, password: account.password },
  });
  expect(login.ok(), 'notification fixture login should succeed').toBeTruthy();
  return ((await login.json()) as { idToken: string }).idToken;
}

async function createTask(
  request: APIRequestContext,
  idToken: string,
  plantId: string,
  type: string,
  nextDue: string
): Promise<string> {
  const created = await request.post(`${API_URL}/tasks`, {
    headers: { Authorization: `Bearer ${idToken}` },
    data: { plantId, type, frequency: 7, nextDue },
  });
  expect(created.status(), 'notification fixture task creation should succeed').toBe(201);
  return ((await created.json()) as { id: string }).id;
}

function readCalls(page: Page): Promise<CapturedNotification[]> {
  return page.evaluate((callsKey) => {
    const raw = sessionStorage.getItem(callsKey);
    return raw ? (JSON.parse(raw) as CapturedNotification[]) : [];
  }, CALLS_KEY);
}

function readAnnounced(page: Page, announcedKey: string): Promise<string | null> {
  return page.evaluate((key) => sessionStorage.getItem(key), announcedKey);
}

test('an open tab alerts when a task turns overdue, respects permission, and dedupes the occurrence', async ({
  page,
  context,
  request,
  browserName,
}, testInfo) => {
  test.skip(
    browserName !== 'chromium' || testInfo.project.name !== 'chromium',
    'Chromium is the project that supports real Notification permission in headless CI'
  );

  const { startsAt, dueAt, turnsOverdueAt } = fixtureClock();

  const account = await provisionAccount({
    emailPrefix: 'foreground-notification',
    plant: { name: 'Timer Fern', species: 'Nephrolepis exaltata' },
    waterTask: { frequency: 7, nextDue: dueAt.toISOString() },
  });
  const waterTaskId = account.taskId;
  const plantId = account.plantId;
  if (!waterTaskId || !plantId) {
    throw new Error('Notification fixture did not create a plant and task');
  }
  // The hook's seen-set is household-scoped; asserting on the key directly is
  // what makes the seeding precondition below visible instead of implied.
  const announcedKey = `fg.overdueAlerts.announced.${account.householdId}`;
  const idToken = await loginToken(request, account);

  await page.clock.install({ time: startsAt });

  // Instrument the native constructor rather than replacing permission
  // semantics: static properties/methods still flow through the Proxy to the
  // browser's real Notification implementation.
  //
  // The local opt-in rides along in the same init script because it has to be
  // in place before the dashboard's FIRST render. `isEnabledLocally()` gates
  // `useOverdueAlerts` ahead of everything else it does, seeding included, so
  // a run that starts without the opt-in does not merely stay quiet — it
  // leaves the seen-set unwritten, and the next enabled run swallows whatever
  // is overdue by then as its silent seed.
  await page.addInitScript((callsKey) => {
    // The durable opt-in left by a prior grant. Resetting the browser
    // permission later must still prevent delivery.
    localStorage.setItem('fg.notifications.enabled', '1');

    const NativeNotification = window.Notification;
    if (!NativeNotification) return;

    window.Notification = new Proxy(NativeNotification, {
      construct(target, args, newTarget) {
        // Only record after Chromium's real constructor succeeds. Recording
        // first would let the test pass even if the browser rejected delivery.
        // `Reflect.construct` is typed `any`; name the type the proxy target
        // actually produces so the unsafe-any rules have something to check.
        const notification = Reflect.construct(target, args, newTarget) as Notification;
        const title = String(args[0]);
        const options = (args[1] ?? {}) as NotificationOptions;
        let calls: CapturedNotification[] = [];
        try {
          calls = JSON.parse(sessionStorage.getItem(callsKey) ?? '[]') as CapturedNotification[];
        } catch {
          // A malformed prior test value should not hide a real notification.
        }
        calls.push({ title, body: options.body, tag: options.tag });
        sessionStorage.setItem(callsKey, JSON.stringify(calls));
        return notification;
      },
    });
  }, CALLS_KEY);

  await context.grantPermissions(['notifications'], { origin: APP_ORIGIN });
  await uiLogin(page, account.email, account.password);
  await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible();

  // ---------------------------------------------------------------- phase 1
  // Everything is armed — permission granted, opt-in stored, a task on screen
  // whose due *instant* passed fourteen hours ago — and nothing fires, because
  // the task is still due today. That silence is #591: the old instant rule
  // alerted here, while the dashboard beside it said "Today".
  //
  // The empty seen-set is also the precondition for every phase below. A
  // non-empty seed means the task was already overdue when the tab opened, in
  // which case the hook records it as seen without alerting and nothing later
  // in this test can ever deliver.
  await expect.poll(() => readAnnounced(page, announcedKey), { timeout: 15_000 }).toBe('[]');
  expect(await readCalls(page), 'a task due later today must not alert').toEqual([]);

  // ---------------------------------------------------------------- phase 2
  // Cross local midnight in the open tab. Nothing reloads and nothing is
  // clicked: the hook's own scheduled wake-up is the only thing that can
  // notice, which is the behaviour #591 asked for.
  await page.clock.fastForward(turnsOverdueAt.getTime() - startsAt.getTime() + 60_000);
  expect(
    await page.evaluate(() => Date.now()),
    'the fixture clock must actually cross the local-midnight boundary'
  ).toBeGreaterThan(turnsOverdueAt.getTime());

  await expect
    .poll(() => readCalls(page), { timeout: 12_000, intervals: [100, 250, 500] })
    .toEqual([
      expect.objectContaining({
        title: 'Timer Fern could use a little care',
        body: 'water is ready whenever you are.',
        tag: `task-${waterTaskId}`,
      }),
    ]);

  // ---------------------------------------------------------------- phase 3
  // Visibility/focus reconciliation and a full reload all revisit the same
  // overdue occurrence. Session dedupe must keep it at exactly one alert.
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible();
  await page.waitForTimeout(1_000);
  expect(await readCalls(page), 'one occurrence is one alert').toHaveLength(1);

  // ---------------------------------------------------------------- phase 4
  // Permission is revoked in browser settings while the tab is open, and a
  // second task — overdue, and new to the seen-set — appears. This is the one
  // arrangement that isolates the permission check: the state is identical to
  // phase 5's, which delivers, and differs only in the permission.
  const fertilizeTaskId = await createTask(
    request,
    idToken,
    plantId,
    'fertilize',
    dueAt.toISOString()
  );
  await context.clearPermissions();
  await expect.poll(() => page.evaluate(() => Notification.permission)).not.toBe('granted');
  await page.reload();
  await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible();
  await page.waitForTimeout(1_000);
  expect(await readCalls(page), 'a revoked browser permission blocks delivery').toHaveLength(1);
  // A suppressed alert must not be banked as announced, or granting permission
  // later would lose it for the rest of the session.
  expect(await readAnnounced(page, announcedKey)).toBe(JSON.stringify([waterTaskId]));

  // ---------------------------------------------------------------- phase 5
  // Grant it back and the very same occurrence delivers, which is what makes
  // phase 4 a permission assertion rather than a restatement of phase 3.
  await context.grantPermissions(['notifications'], { origin: APP_ORIGIN });
  await expect.poll(() => page.evaluate(() => Notification.permission)).toBe('granted');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));

  await expect
    .poll(() => readCalls(page), { timeout: 12_000, intervals: [100, 250, 500] })
    .toEqual([
      expect.objectContaining({ tag: `task-${waterTaskId}` }),
      expect.objectContaining({
        title: 'Timer Fern could use a little care',
        body: 'fertilize is ready whenever you are.',
        tag: `task-${fertilizeTaskId}`,
      }),
    ]);
});
