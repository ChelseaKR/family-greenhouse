import { test, expect } from '@playwright/test';

test.describe('Authentication', () => {
  test('login page is reachable from /login directly', async ({ page }) => {
    await page.goto('/login');
    await expect(page).toHaveURL(/\/login/);
    // The AuthShell redesign titles the login page "Welcome back" — the
    // "Sign in" copy lives on the submit button (asserted in the next test).
    await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible();
  });

  test('login page has required fields', async ({ page }) => {
    await page.goto('/login');

    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByLabel(/password/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();
  });

  test('shows validation errors for invalid input', async ({ page }) => {
    await page.goto('/login');

    // Submit empty form
    await page.getByRole('button', { name: /sign in/i }).click();

    // Should show validation errors. Target the alert specifically —
    // bare getByText(/email/i) is ambiguous because the "Email address"
    // field label matches too.
    await expect(page.getByRole('alert').filter({ hasText: /email/i })).toBeVisible();
  });

  test('keeps login available without a registration link', async ({ page }) => {
    await page.goto('/login');

    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();
    await expect(page.locator('a[href^="/register"]')).toHaveCount(0);
    await expect(page.getByRole('link', { name: /demo status/i })).toHaveAttribute(
      'href',
      '/pricing'
    );
  });

  test('register route is status-only with no signup form', async ({ page }) => {
    await page.goto('/register');

    await expect(
      page.getByRole('heading', { name: /new account registration is paused/i })
    ).toBeVisible();
    await expect(page.locator('form')).toHaveCount(0);
    await expect(page.locator('input')).toHaveCount(0);
    await expect(page.getByRole('link', { name: /sign in/i })).toHaveAttribute('href', '/login');
  });

  test('has link to forgot password', async ({ page }) => {
    await page.goto('/login');

    await page.getByRole('link', { name: /forgot/i }).click();
    await expect(page).toHaveURL(/\/forgot-password/);
  });
});

test.describe('Accessibility', () => {
  test('login page form fields use semantic types', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByLabel(/email/i)).toHaveAttribute('type', 'email');
    await expect(page.getByLabel(/password/i)).toHaveAttribute('type', 'password');
    await expect(page.getByRole('button', { name: /sign in/i })).toBeEnabled();
  });
});
