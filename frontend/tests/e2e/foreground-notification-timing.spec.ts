import { expect, test } from '@playwright/test';
import { provisionAccount, uiLogin } from './helpers';

const API_URL = 'http://localhost:4000';
const CALLS_KEY = 'fg.e2e.foregroundNotificationCalls';

interface CapturedNotification {
  title: string;
  body?: string;
  tag?: string;
}

async function updateTaskDue(
  request: import('@playwright/test').APIRequestContext,
  account: Awaited<ReturnType<typeof provisionAccount>>,
  nextDue: string
): Promise<void> {
  if (!account.taskId) throw new Error('Notification fixture did not create a task');
  const login = await request.post(`${API_URL}/auth/login`, {
    data: { email: account.email, password: account.password },
  });
  expect(login.ok(), 'notification fixture login should succeed').toBeTruthy();
  const { idToken } = (await login.json()) as { idToken: string };

  const updated = await request.put(`${API_URL}/tasks/${account.taskId}`, {
    headers: { Authorization: `Bearer ${idToken}` },
    data: { nextDue },
  });
  expect(updated.ok(), 'notification fixture task update should succeed').toBeTruthy();
}

/**
 * A due date that is genuinely in a previous calendar day.
 *
 * 26 hours rather than 24: a 24-hour offset lands on the same wall-clock time
 * yesterday, which on the day a DST transition removes an hour can still
 * resolve to today. The predicate under test is a calendar-day comparison, so
 * the fixture has to clear a calendar day, not a duration.
 */
function yesterdayIso(): string {
  return new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
}

test('an open tab alerts at the due time, respects permission, and dedupes the occurrence', async ({
  page,
  context,
  request,
  browserName,
}, testInfo) => {
  test.skip(
    browserName !== 'chromium' || testInfo.project.name !== 'chromium',
    'Chromium is the project that supports real Notification permission in headless CI'
  );

  const account = await provisionAccount({
    emailPrefix: 'foreground-notification',
    plant: { name: 'Timer Fern', species: 'Nephrolepis exaltata' },
    waterTask: {
      frequency: 7,
      nextDue: new Date(Date.now() + 86_400_000).toISOString(),
    },
  });
  const taskId = account.taskId;
  if (!taskId) throw new Error('Notification fixture did not create a task');

  // Instrument the native constructor rather than replacing permission
  // semantics: static properties/methods still flow through the Proxy to the
  // browser's real Notification implementation.
  await page.addInitScript((callsKey) => {
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

  await uiLogin(page, account.email, account.password);
  await page.evaluate((callsKey) => {
    sessionStorage.removeItem(callsKey);
    // This is the durable opt-in left by a prior grant. Resetting browser
    // permission later must still prevent delivery.
    localStorage.setItem('fg.notifications.enabled', '1');
  }, CALLS_KEY);

  expect(await page.evaluate(() => Notification.permission)).not.toBe('granted');
  // Yesterday, not "a second from now". Since #591 the alert fires when a task
  // turns OVERDUE — at local midnight after its due day — not at the instant it
  // falls due. A task due later today is not overdue, so a due-soon fixture here
  // would make this assertion pass whether or not the permission check works:
  // nothing would alert either way. An already-overdue task is the only fixture
  // that isolates the thing under test.
  await updateTaskDue(request, account, yesterdayIso());
  await page.reload();
  await page.waitForTimeout(1_500);
  expect(await page.evaluate((callsKey) => sessionStorage.getItem(callsKey), CALLS_KEY)).toBeNull();

  await context.grantPermissions(['notifications'], { origin: 'http://localhost:3000' });
  expect(await page.evaluate(() => Notification.permission)).toBe('granted');

  await updateTaskDue(request, account, yesterdayIso());
  await page.reload();
  await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible();

  await expect
    .poll(
      async () =>
        page.evaluate((callsKey) => {
          const raw = sessionStorage.getItem(callsKey);
          return raw ? (JSON.parse(raw) as CapturedNotification[]) : [];
        }, CALLS_KEY),
      { timeout: 12_000, intervals: [100, 250, 500] }
    )
    .toEqual([
      expect.objectContaining({
        title: 'Timer Fern could use a little care',
        body: 'water is ready whenever you are.',
        tag: `task-${taskId}`,
      }),
    ]);

  // Visibility/focus reconciliation and a full reload all revisit the same
  // overdue occurrence. Session dedupe must keep it at exactly one alert.
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.reload();
  await page.waitForTimeout(500);
  const calls = await page.evaluate((callsKey) => {
    return JSON.parse(sessionStorage.getItem(callsKey) ?? '[]') as CapturedNotification[];
  }, CALLS_KEY);
  expect(calls).toHaveLength(1);
});
