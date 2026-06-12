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

  test('has link to register page', async ({ page }) => {
    await page.goto('/login');

    await page.getByRole('link', { name: /sign up/i }).click();
    await expect(page).toHaveURL(/\/register/);
  });

  test('register page has required fields', async ({ page }) => {
    await page.goto('/register');

    await expect(page.getByLabel(/full name/i)).toBeVisible();
    await expect(page.getByLabel(/email/i)).toBeVisible();
    // Required fields render a trailing "*" marker inside the label, so
    // anchor on the word but allow the marker.
    await expect(page.getByLabel(/^password\s*\*?$/i)).toBeVisible();
    await expect(page.getByLabel(/confirm password/i)).toBeVisible();
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
