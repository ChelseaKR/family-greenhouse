import { expect, test } from '@playwright/test';
import { provisionAccount, uiLogin } from './helpers';

test('notification settings match this browser engine’s real capability and permission state', async ({
  page,
}, testInfo) => {
  const account = await provisionAccount({ emailPrefix: 'notification-capability' });
  await uiLogin(page, account.email, account.password);
  await page.goto('/settings?section=notifications');
  await expect(page.getByRole('heading', { name: /notifications/i }).first()).toBeVisible();

  const capability = await page.evaluate(() => ({
    supported: 'Notification' in window,
    permission: 'Notification' in window ? Notification.permission : 'unsupported',
    serviceWorker: 'serviceWorker' in navigator,
    pushManager: 'PushManager' in window,
  }));
  await testInfo.attach('notification-capability.json', {
    body: JSON.stringify({ project: testInfo.project.name, ...capability }, null, 2),
    contentType: 'application/json',
  });

  if (!capability.supported) {
    await expect(
      page.getByText(/Browser reminders are not supported on this device/i)
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enable' })).toHaveCount(0);
    return;
  }

  await expect(page.getByText('Browser', { exact: true })).toBeVisible();
  const enable = page.getByRole('button', { name: 'Enable' });
  await expect(enable).toBeVisible();
  if (capability.permission === 'denied') {
    await expect(enable).toBeDisabled();
    await expect(page.getByText(/Permission denied — update your browser settings/i)).toBeVisible();
  } else {
    await expect(enable).toBeEnabled();
    await expect(
      page.getByText('Enable to be alerted when overdue tasks appear in the dashboard.')
    ).toBeVisible();
  }
});

test('a denied permission becomes actionable after browser settings return it to default', async ({
  page,
}) => {
  const permissionStorageId = 'fg.e2e.notificationPermission';
  await page.addInitScript((key) => {
    class ControlledNotification {
      static get permission(): NotificationPermission {
        return (sessionStorage.getItem(key) as NotificationPermission | null) ?? 'denied';
      }

      static requestPermission(): Promise<NotificationPermission> {
        return Promise.resolve(ControlledNotification.permission);
      }
    }
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: ControlledNotification,
    });
  }, permissionStorageId);

  const account = await provisionAccount({ emailPrefix: 'notification-permission-refresh' });
  await uiLogin(page, account.email, account.password);
  await page.goto('/settings?section=notifications');

  const enable = page.getByRole('button', { name: 'Enable' });
  await expect(enable).toBeDisabled();
  await expect(page.getByText(/Permission denied — update your browser settings/i)).toBeVisible();

  await page.evaluate((key) => {
    sessionStorage.setItem(key, 'default');
    window.dispatchEvent(new Event('focus'));
  }, permissionStorageId);

  await expect(enable).toBeEnabled();
  await expect(
    page.getByText('Enable to be alerted when overdue tasks appear in the dashboard.')
  ).toBeVisible();
});

test('the production bundle activates the generated worker with the push handler imported', async ({
  page,
}) => {
  await page.goto('/');

  const workerResponse = await page.request.get('/sw.js');
  expect(workerResponse.ok()).toBeTruthy();
  expect(await workerResponse.text()).toContain('push-handler.js');

  const pushHandlerResponse = await page.request.get('/push-handler.js');
  expect(pushHandlerResponse.ok()).toBeTruthy();
  expect(await pushHandlerResponse.text()).toContain("addEventListener('push'");

  const serviceWorkerSupported = await page.evaluate(() => 'serviceWorker' in navigator);
  if (!serviceWorkerSupported) {
    // The static scripts are still present for supported browsers; this engine
    // cannot activate them, so registration is a browser limitation.
    return;
  }

  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const registration = await navigator.serviceWorker.getRegistration();
          return (
            registration?.active?.scriptURL ??
            registration?.waiting?.scriptURL ??
            registration?.installing?.scriptURL ??
            ''
          );
        }),
      { timeout: 15_000, intervals: [100, 250, 500] }
    )
    .toMatch(/\/sw\.js$/);
});

test('the reminder deep link opens the due queue and includes overdue care', async ({ page }) => {
  const account = await provisionAccount({
    emailPrefix: 'notification-deep-link',
    plant: { name: 'Deep Link Fern', species: 'Nephrolepis exaltata' },
    waterTask: {
      frequency: 7,
      nextDue: new Date(Date.now() - 86_400_000).toISOString(),
    },
  });
  await uiLogin(page, account.email, account.password);
  await page.goto('/tasks?filter=due');

  await expect(page).toHaveURL(/\/tasks\?filter=due$/);
  await expect(page.getByRole('button', { name: /^today$/i })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  const taskRow = page.locator('li', {
    has: page.getByRole('link', { name: 'Deep Link Fern' }),
  });
  await expect(taskRow).toBeVisible();
  await expect(taskRow.getByText(/overdue/i)).toBeVisible();
});

test.describe('notification preference network recovery', () => {
  // Workbox can take control before the lazy settings query in WebKit. Block
  // the worker only for this synthetic outage so Playwright can deterministically
  // intercept the network boundary; worker activation has its own real test above.
  test.use({ serviceWorkers: 'block' });

  test('loading errors are actionable and recover in place', async ({ page, context }) => {
    const account = await provisionAccount({ emailPrefix: 'notification-load-retry' });
    let failPreferences = true;
    await context.route('**/notifications/prefs*', async (route) => {
      if (route.request().method() === 'GET' && failPreferences) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            message: 'Notification preferences are temporarily unavailable.',
          }),
        });
        return;
      }
      await route.continue();
    });

    await uiLogin(page, account.email, account.password);
    await page.goto('/settings?section=notifications');
    await expect(
      page.getByRole('alert').filter({
        hasText: 'Notification preferences are temporarily unavailable.',
      })
    ).toBeVisible();

    failPreferences = false;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('checkbox', { name: 'Email notifications' })).toBeVisible();
  });
});
