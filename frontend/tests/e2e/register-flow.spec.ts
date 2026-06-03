import { test, expect } from '@playwright/test';

/**
 * Sign-up + email confirmation flow.
 *
 * The local Express dev server (`backend/src/local-server.ts`) uses a fixed
 * confirmation code of `123456` for every signup so tests can exercise the
 * full register → confirm → dashboard handoff without needing to scrape
 * server logs or hit a test-only endpoint. Each test mints a fresh email so
 * the in-memory user store doesn't reject the signup as a duplicate on
 * re-runs against a sticky local server.
 */
test.describe('Register flow', () => {
  test('register → confirm with correct code → land on onboarding/dashboard', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('pageerror', (err) => consoleErrors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    const email = `new-user-${Date.now()}@example.com`;

    await page.goto('/register');
    await page.getByLabel(/full name/i).fill('Test Newcomer');
    await page.getByLabel(/email/i).fill(email);
    // The Input component renders the label as `Password` + a hidden `*`
    // marker, so the accessible name is `Password *`. Match by exact
    // attribute via the input element itself to dodge that quirk.
    await page.locator('input[autocomplete="new-password"]').first().fill('Password123');
    await page.locator('input[autocomplete="new-password"]').nth(1).fill('Password123');
    await page.getByRole('button', { name: /create account/i }).click();

    // After a successful signup we're routed to /confirm-email with the
    // email tucked into router state. The page surfaces the address as a
    // verification cue.
    await expect(page).toHaveURL(/\/confirm-email/);
    await expect(page.getByText(email)).toBeVisible();

    // 123456 is the fixed dev-mode code from local-server.ts.
    await page.getByLabel(/confirmation code/i).fill('123456');
    await page.getByRole('button', { name: /confirm email/i }).click();

    // New users without a household are kicked into the onboarding wizard.
    await expect(page).toHaveURL(/\/onboarding/);
    expect(consoleErrors).toEqual([]);
  });

  test('register → confirm with wrong code shows an error and stays on confirm', async ({
    page,
  }) => {
    const email = `bad-code-${Date.now()}@example.com`;

    await page.goto('/register');
    await page.getByLabel(/full name/i).fill('Bad Code User');
    await page.getByLabel(/email/i).fill(email);
    // See note above: Input label renders "Password *" so /^password$/i
    // misses. autocomplete is the most stable hook.
    await page.locator('input[autocomplete="new-password"]').first().fill('Password123');
    await page.locator('input[autocomplete="new-password"]').nth(1).fill('Password123');
    await page.getByRole('button', { name: /create account/i }).click();

    await expect(page).toHaveURL(/\/confirm-email/);

    // A 6-digit value clears the zod min-length check but fails the
    // backend's pendingConfirmations lookup, so the API returns
    // "Invalid confirmation code".
    await page.getByLabel(/confirmation code/i).fill('000000');
    await page.getByRole('button', { name: /confirm email/i }).click();

    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('alert')).toContainText(/invalid confirmation code/i);
    await expect(page).toHaveURL(/\/confirm-email/);
  });

  test('confirm-email page without a registered email shows the recovery prompt', async ({
    page,
  }) => {
    // Hitting /confirm-email directly (no router state) should not crash;
    // the page renders a "No email on file" fallback with a link back to
    // /register.
    await page.goto('/confirm-email');

    await expect(page.getByText(/no email address provided/i)).toBeVisible();
    await page.getByRole('link', { name: /go to registration/i }).click();
    await expect(page).toHaveURL(/\/register/);
  });
});
