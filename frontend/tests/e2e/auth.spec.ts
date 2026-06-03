import { test, expect } from '@playwright/test';

test.describe('Authentication', () => {
  test('login page is reachable from /login directly', async ({ page }) => {
    await page.goto('/login');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('heading', { name: /sign in/i })).toBeVisible();
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

    // Should show validation errors
    await expect(page.getByText(/email/i)).toBeVisible();
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
    await expect(page.getByLabel(/^password$/i)).toBeVisible();
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
