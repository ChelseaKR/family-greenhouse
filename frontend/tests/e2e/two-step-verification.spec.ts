import { test, expect, request as playwrightRequest, type Page } from '@playwright/test';
import { provisionAccount, uiLogin } from './helpers';
import { FIXED_TOTP_SECRET, acceptedCodes, rejectedCode, totpCode } from './totp';

/**
 * Two-step verification (#671), end to end in a real browser against the
 * local mock backend: enroll an authenticator in Settings → Security, sign
 * out, then sign in with password + code.
 *
 * The mock checks codes with real RFC 6238 arithmetic (backend
 * src/local-server-mfa.ts), so a client that sent the wrong code would fail
 * here. The secret the page shows is compared with the pinned CI secret, and
 * every code typed is computed from what the page showed — so the manual-key
 * display is part of what is tested, not bypassed.
 *
 * Each test provisions its own account: the seed account is shared across
 * projects and turning a factor on for it would break every other spec.
 */

const API_URL = 'http://localhost:4000';

async function signOut(page: Page) {
  const hamburger = page.getByRole('button', { name: /open sidebar/i });
  if (await hamburger.isVisible()) await hamburger.click();
  await page
    .getByRole('button', { name: /sign out/i })
    .filter({ visible: true })
    .first()
    .click();
  await expect(page).not.toHaveURL(/\/(dashboard|settings)/, { timeout: 15000 });
}

async function enroll(page: Page, password: string): Promise<string> {
  await page.goto('/settings?section=security');
  await page.getByRole('button', { name: /set up an authenticator app/i }).click();
  await page.getByLabel(/current password/i).fill(password);
  await page.getByRole('button', { name: /^continue$/i }).click();

  await expect(
    page.getByRole('img', { name: /qr code for adding family greenhouse/i })
  ).toBeVisible({
    timeout: 15000,
  });
  const shown = ((await page.getByTestId('totp-secret').textContent()) ?? '').replace(/\s+/g, '');
  expect(shown).toMatch(/^[A-Z2-7]{32}$/);
  // In CI the webServer pins the secret; a reused local dev server may not.
  if (process.env.CI) expect(shown).toBe(FIXED_TOTP_SECRET);

  await page.getByLabel(/6-digit code from the app/i).fill(totpCode(shown));
  await page.getByRole('button', { name: /turn on two-step verification/i }).click();
  await expect(page.getByRole('heading', { name: /two-step verification is on/i })).toBeVisible();
  await expect(page.getByRole('heading', { name: /keep a way back in/i })).toBeVisible();
  await page.getByRole('button', { name: /^done$/i }).click();
  await expect(page.getByTestId('totp-status')).toContainText(/two-step verification is on/i);
  return shown;
}

async function passwordStep(page: Page, email: string, password: string) {
  await page.goto('/login');
  const emailField = page.getByLabel(/email/i);
  await emailField.waitFor({ state: 'visible', timeout: 15000 });
  await emailField.fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByRole('heading', { name: /two-step verification/i })).toBeVisible({
    timeout: 15000,
  });
}

test.describe('Two-step verification (TOTP)', () => {
  test('enroll, sign out, then sign in with password + code; a wrong code fails', async ({
    page,
  }) => {
    const account = await provisionAccount({ emailPrefix: 'totp' });
    await uiLogin(page, account.email, account.password);
    const secret = await enroll(page, account.password);
    await signOut(page);

    // The server really enforces it: a password alone no longer mints tokens.
    const api = await playwrightRequest.newContext();
    try {
      const res = await api.post(`${API_URL}/auth/login`, {
        data: { email: account.email, password: account.password },
      });
      const body = (await res.json()) as { challenge?: string; idToken?: string };
      expect(body.challenge).toBe('SOFTWARE_TOKEN_MFA');
      expect(body.idToken).toBeUndefined();
    } finally {
      await api.dispose();
    }

    await passwordStep(page, account.email, account.password);
    await expect(page.getByLabel(/authentication code/i)).toBeFocused();

    // Negative control: prove the code about to be typed is one the server
    // would reject at this moment, THEN that the page refuses it.
    const wrong = rejectedCode(secret);
    expect(acceptedCodes(secret).has(wrong)).toBe(false);
    await page.getByLabel(/authentication code/i).fill(wrong);
    await page.getByRole('button', { name: /verify code/i }).click();
    await expect(page.getByText(/code didn.t match/i)).toBeVisible();
    await expect(page).toHaveURL(/\/login/);

    await page.getByLabel(/authentication code/i).fill(totpCode(secret));
    await page.getByRole('button', { name: /verify code/i }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15000 });
  });

  test('turning it off needs a code, and then the password alone signs in', async ({ page }) => {
    const account = await provisionAccount({ emailPrefix: 'totp-off' });
    await uiLogin(page, account.email, account.password);
    const secret = await enroll(page, account.password);

    await page.getByRole('button', { name: /turn off two-step verification/i }).click();
    const form = page.getByRole('form', { name: /turn off two-step verification/i });
    await form.getByLabel(/current password/i).fill(account.password);

    // Negative control: a rejected code leaves it on.
    const wrong = rejectedCode(secret);
    expect(acceptedCodes(secret).has(wrong)).toBe(false);
    await form.getByLabel(/6-digit code/i).fill(wrong);
    await form.getByRole('button', { name: /^turn off$/i }).click();
    await expect(form.getByText(/code didn.t match/i)).toBeVisible();

    await form.getByLabel(/current password/i).fill(account.password);
    await form.getByLabel(/6-digit code/i).fill(totpCode(secret));
    await form.getByRole('button', { name: /^turn off$/i }).click();
    await expect(page.getByTestId('totp-status')).toContainText(/two-step verification is off/i);

    await signOut(page);
    await uiLogin(page, account.email, account.password);
  });
});
