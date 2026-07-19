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

  test('links login to free registration', async ({ page }) => {
    await page.goto('/login');

    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /sign up free/i })).toHaveAttribute(
      'href',
      '/register'
    );
  });

  test('register route has the free signup form', async ({ page }) => {
    await page.goto('/register');

    await expect(page.getByRole('heading', { name: /start your greenhouse/i })).toBeVisible();
    await expect(page.getByLabel(/full name/i)).toBeVisible();
    await expect(page.getByLabel(/email address/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /create account/i })).toBeEnabled();
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
