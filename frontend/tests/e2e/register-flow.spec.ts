import { test, expect } from '@playwright/test';

/** Commercial-hold regression coverage for registration and confirmation entry points. */
test.describe('Registration hold', () => {
  test('direct /register navigation exposes no form and sends no signup request', async ({
    page,
  }) => {
    let signupRequests = 0;
    page.on('request', (request) => {
      if (request.url().includes('/auth/signup')) signupRequests += 1;
    });

    await page.goto('/register');

    await expect(
      page.getByRole('heading', { name: /new account registration is paused/i })
    ).toBeVisible();
    await expect(page.getByText(/new signups.*unavailable/i)).toBeVisible();
    await expect(page.locator('form')).toHaveCount(0);
    await expect(page.locator('input')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /create account/i })).toHaveCount(0);
    await expect(page.locator('a[href^="/register"]')).toHaveCount(0);
    await expect(page.getByRole('link', { name: /sign in/i })).toHaveAttribute('href', '/login');
    expect(signupRequests).toBe(0);
  });

  test('confirm-email without pending state points existing users to login', async ({ page }) => {
    await page.goto('/confirm-email');

    await expect(page.getByText(/no email address provided/i)).toBeVisible();
    await expect(page.locator('a[href^="/register"]')).toHaveCount(0);
    await expect(page.getByRole('link', { name: /sign in/i })).toHaveAttribute('href', '/login');
  });
});
