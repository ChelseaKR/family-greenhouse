import { test, expect } from '@playwright/test';

/** Full free-account registration and email-confirmation flow. */
test.describe('Register flow', () => {
  test('register → confirm → sign in → land on onboarding', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('pageerror', (err) => consoleErrors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    const email = `new-user-${Date.now()}@example.com`;
    const password = 'Password1234';

    await page.goto('/register');
    await page.getByLabel(/full name/i).fill('Test Newcomer');
    await page.getByLabel(/email/i).fill(email);
    await page.locator('input[autocomplete="new-password"]').first().fill(password);
    await page.locator('input[autocomplete="new-password"]').nth(1).fill(password);
    await page.getByRole('button', { name: /create account/i }).click();

    await expect(page).toHaveURL(/\/confirm-email/);
    await expect(page.getByText(email)).toBeVisible();

    await page.getByLabel(/confirmation code/i).fill('123456');
    await page.getByRole('button', { name: /confirm email/i }).click();

    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText(/email confirmed/i)).toBeVisible();
    await expect(page.getByLabel(/email address/i)).toHaveValue(email);

    await page.getByLabel(/password/i).fill(password);
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/onboarding/);
    expect(consoleErrors).toEqual([]);
  });

  test('wrong confirmation code shows an error and stays on confirm', async ({ page }) => {
    const email = `bad-code-${Date.now()}@example.com`;
    const password = 'Password1234';

    await page.goto('/register');
    await page.getByLabel(/full name/i).fill('Bad Code User');
    await page.getByLabel(/email/i).fill(email);
    await page.locator('input[autocomplete="new-password"]').first().fill(password);
    await page.locator('input[autocomplete="new-password"]').nth(1).fill(password);
    await page.getByRole('button', { name: /create account/i }).click();

    await expect(page).toHaveURL(/\/confirm-email/);
    await page.getByLabel(/confirmation code/i).fill('000000');
    await page.getByRole('button', { name: /confirm email/i }).click();

    await expect(page.getByRole('alert')).toContainText(/invalid confirmation code/i);
    await expect(page).toHaveURL(/\/confirm-email/);
  });

  test('confirm-email without pending state offers confirmation recovery', async ({ page }) => {
    await page.goto('/confirm-email');

    await expect(page.getByRole('heading', { name: /continue email confirmation/i })).toBeVisible();
    await expect(page.getByLabel(/email address/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /send confirmation code/i })).toBeEnabled();
  });
});
