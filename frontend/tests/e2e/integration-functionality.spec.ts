import { expect, test } from '@playwright/test';
import { provisionAccount, uiLogin } from './helpers';

/**
 * Browser-level functionality for the user-facing integrations that are easy
 * to accidentally reduce to render-only coverage. Every test uses the real
 * local HTTP server and a unique account, so the five-browser matrix can run
 * concurrently without sharing mutable user state.
 */

test('password recovery changes the credential and the new password signs in', async ({ page }) => {
  const account = await provisionAccount({ emailPrefix: 'password-recovery' });
  const newPassword = 'ChangedPassword5678';

  await page.goto('/forgot-password');
  await page.getByLabel(/email address/i).fill(account.email);
  await page.getByRole('button', { name: /send reset code/i }).click();
  await expect(page).toHaveURL(/\/reset-password$/);

  await page.getByLabel(/reset code/i).fill('123456');
  await page.getByLabel(/^new password/i).fill(newPassword);
  await page.getByLabel(/confirm new password/i).fill(newPassword);
  await page.getByRole('button', { name: /reset password/i }).click();
  await expect(page.getByText(/reset successfully/i)).toBeVisible();

  await page.getByRole('link', { name: /sign in/i }).click();
  await page.getByLabel(/email/i).fill(account.email);
  await page.getByLabel(/password/i).fill(newPassword);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 15_000 });
});

test('notification preferences, phone verification, and quiet hours survive reload', async ({
  page,
  context,
  browserName,
}) => {
  const account = await provisionAccount({ emailPrefix: 'notifications' });
  if (browserName === 'chromium') {
    await context.grantPermissions(['notifications'], { origin: 'http://localhost:3000' });
  }
  await uiLogin(page, account.email, account.password);
  await page.goto('/settings?section=notifications');
  if (browserName === 'chromium') {
    expect(await page.evaluate(() => Notification.permission)).toBe('granted');
  }

  const email = page.getByLabel('Email notifications');
  const digest = page.getByLabel(/weekly.*digest/i);
  const pestAlerts = page.getByLabel('Pest alerts');
  const sms = page.getByLabel('SMS notifications');
  await expect(email).toBeChecked();
  await expect(digest).toBeChecked();
  await expect(pestAlerts).not.toBeChecked();

  async function toggleAndWait(locator: typeof email) {
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith('/notifications/prefs') &&
        response.request().method() === 'PUT' &&
        response.ok()
    );
    await locator.click();
    await saved;
  }

  await toggleAndWait(pestAlerts);
  await toggleAndWait(digest);
  await toggleAndWait(email);
  await expect(digest).toBeDisabled();
  await toggleAndWait(email);

  const phone = '+15551234567';
  await page.getByLabel(/phone number/i).fill(phone);
  const verificationStarted = page.waitForResponse(
    (response) =>
      response.url().endsWith('/notifications/phone/start-verification') &&
      response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: /send code/i }).click();
  const startResponse = await verificationStarted;
  expect(startResponse.ok()).toBeTruthy();
  const { devCode } = (await startResponse.json()) as { devCode: string };
  expect(devCode).toMatch(/^\d{6}$/);

  await page.getByLabel(/verification code/i).fill(devCode);
  const verified = page.waitForResponse(
    (response) =>
      response.url().endsWith('/notifications/phone/confirm-verification') &&
      response.request().method() === 'POST' &&
      response.ok()
  );
  await page.getByRole('button', { name: /^verify$/i }).click();
  await verified;
  await expect(page.getByTestId('phone-verified-badge')).toBeVisible();
  await toggleAndWait(sms);

  await page.getByLabel(/^start$/i).fill('22:00');
  await page.getByLabel(/^end$/i).fill('07:00');
  await page.getByLabel(/^timezone$/i).fill('America/Los_Angeles');
  const quietHoursSaved = page.waitForResponse(
    (response) =>
      response.url().endsWith('/notifications/prefs') &&
      response.request().method() === 'PUT' &&
      response.ok()
  );
  await page.getByRole('button', { name: /save quiet hours/i }).click();
  await quietHoursSaved;

  // Chromium can grant the real Notification permission in automation. Vite
  // intentionally has no VAPID key/service worker, so this proves the honest
  // foreground-only state rather than pretending background push is active.
  if (browserName === 'chromium') {
    const browserPreferenceSaved = page.waitForResponse(
      (response) =>
        response.url().endsWith('/notifications/prefs') &&
        response.request().method() === 'PUT' &&
        response.ok()
    );
    await page.getByRole('button', { name: /^enable$/i }).click();
    await browserPreferenceSaved;
    await expect(page.getByText(/tab is open|foreground/i)).toBeVisible();
  }

  await page.reload();
  await expect(page.getByRole('heading', { name: /notifications/i }).first()).toBeVisible();
  await expect(email).toBeChecked();
  await expect(digest).not.toBeChecked();
  await expect(pestAlerts).toBeChecked();
  await expect(sms).toBeChecked();
  await expect(page.getByLabel(/phone number/i)).toHaveValue(phone);
  await expect(page.getByTestId('phone-verified-badge')).toBeVisible();
  await expect(page.getByLabel(/^start$/i)).toHaveValue('22:00');
  await expect(page.getByLabel(/^end$/i)).toHaveValue('07:00');
  await expect(page.getByLabel(/^timezone$/i)).toHaveValue('America/Los_Angeles');
});

test('account profile, password, export, and permanent deletion work through the UI', async ({
  page,
}) => {
  const account = await provisionAccount({
    emailPrefix: 'account-lifecycle',
    plant: { name: 'Export Fern', species: 'Nephrolepis exaltata' },
    waterTask: { frequency: 5 },
  });
  const newPassword = 'AccountPassword5678';
  await uiLogin(page, account.email, account.password);
  await page.goto('/account');

  const name = page.getByLabel(/^name/i);
  await name.fill('Renamed Gardener');
  await page.getByRole('button', { name: /save name/i }).click();
  await expect(page.getByText(/name updated/i)).toBeVisible();

  await page.getByLabel(/current password/i).fill(account.password);
  await page.getByLabel(/^new password/i).fill(newPassword);
  await page.getByLabel(/confirm new password/i).fill(newPassword);
  await page.getByRole('button', { name: /update password/i }).click();
  await expect(page.getByText(/password updated/i)).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /download full data/i }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(
    /^family-greenhouse-export-\d{4}-\d{2}-\d{2}\.json$/
  );

  await page.getByRole('button', { name: /delete my account/i }).click();
  const confirmDelete = page.getByRole('button', { name: /yes, delete/i });
  await expect(confirmDelete).toBeVisible();
  await confirmDelete.click();
  await expect(page).toHaveURL(/\/login$/, { timeout: 15_000 });

  await page.getByLabel(/email/i).fill(account.email);
  await page.getByLabel(/password/i).fill(newPassword);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('alert')).toBeVisible();
});

test('a cutting link previews publicly and grafts into a signed-in greenhouse', async ({
  page,
  browser,
}) => {
  // This exercises two independent browser contexts plus provisioning and a
  // write round-trip. Under the full cross-browser matrix it can legitimately
  // exceed Playwright's generic 30-second budget even though each assertion
  // and the isolated flow complete promptly.
  test.slow();

  const account = await provisionAccount({
    emailPrefix: 'cutting-link',
    householdName: 'Propagation House',
    plant: {
      name: 'Mother Pothos',
      species: 'Epipremnum aureum',
      notes: 'A healthy parent vine.',
    },
  });
  await uiLogin(page, account.email, account.password);
  await page.goto(`/plants/${account.plantId}`);

  await page.getByRole('button', { name: /share cutting/i }).click();
  const dialog = page.getByRole('dialog', { name: /share this cutting/i });
  const shareInput = dialog.getByLabel(/share this cutting/i);
  await expect(shareInput).toHaveValue(/\/shared\//);
  const shareUrl = await shareInput.inputValue();

  const visitorContext = await browser.newContext();
  try {
    const visitor = await visitorContext.newPage();
    await visitor.goto(shareUrl);
    await expect(visitor.getByRole('heading', { name: 'Mother Pothos' })).toBeVisible();
    await expect(visitor.getByText(/Propagation House/)).toBeVisible();
    await expect(visitor.getByText(/A healthy parent vine/)).toBeVisible();
  } finally {
    await visitorContext.close();
  }

  await dialog.getByRole('button', { name: /^close$/i }).click();
  await page.goto(shareUrl);
  await page.getByRole('button', { name: /add to my greenhouse/i }).click();
  await expect(page).toHaveURL(/\/plants\/[^/]+$/, { timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'Mother Pothos' })).toBeVisible();
});

test('a no-account sitter completes real care and the owner sees the history', async ({
  page,
  browser,
}) => {
  const account = await provisionAccount({
    emailPrefix: 'sitter-link',
    space: {
      name: 'Sunroom',
      environment: 'inside',
      lightLevel: 'bright',
    },
    plant: {
      name: 'Holiday Fern',
      species: 'Nephrolepis exaltata',
      location: 'Sunroom shelf',
    },
    waterTask: { frequency: 7, nextDue: new Date(Date.now() - 60_000).toISOString() },
  });
  await uiLogin(page, account.email, account.password);
  await page.goto('/household');
  await page.getByLabel(/label \(optional\)/i).fill('Holiday plants');
  await page.getByRole('button', { name: /create sitter link/i }).click();
  const sitterLink = page.getByLabel('Plant-sitter link');
  await expect(sitterLink).toHaveValue(/\/sit\//);
  const sitterUrl = await sitterLink.inputValue();

  const sitterContext = await browser.newContext();
  try {
    const sitter = await sitterContext.newPage();
    await sitter.goto(sitterUrl);
    await expect(
      sitter.getByRole('heading', { name: /Holiday plants: what needs doing/i })
    ).toBeVisible();
    await expect(sitter.getByText(/Water the Holiday Fern/i)).toBeVisible();
    await expect(sitter.getByText(/Sunroom/)).toBeVisible();
    await sitter.getByRole('button', { name: /mark "Water the Holiday Fern" as done/i }).click();
    await expect(sitter.getByText(/all caught up/i)).toBeVisible();
  } finally {
    await sitterContext.close();
  }

  await page.goto(`/plants/${account.plantId}`);
  await expect(page.getByText(/Plant sitter completed water/i)).toBeVisible();
});
