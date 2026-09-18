import { test, expect, type Page } from '@playwright/test';
import { provisionAccount, uiLogin } from './helpers';

/**
 * Passkeys (#671, second half), end to end in Chromium with a CDP virtual
 * authenticator: a real browser WebAuthn stack makes and uses the
 * credential, so the JSON the app sends is the JSON a real authenticator
 * produces.
 *
 * Two things are arranged rather than real, and both are named here:
 *
 *   - The deployment switch. Production passkeys are off until the owner
 *     applies `passkeys_enabled`, and the Playwright backend runs the same way
 *     (so the sign-in page other specs screenshot is unchanged). This spec
 *     answers the availability probe with `{ available: true }` for its own
 *     page only; the mock serves the passkey routes under the test-fixture
 *     opt-in (backend src/local-server-passkeys.ts).
 *   - The verifier. The mock checks the ceremony type, the challenge binding
 *     and the credential id — not the signature, which in production is
 *     Cognito's to check.
 *
 * Chromium only: the virtual authenticator is a Chrome DevTools Protocol
 * feature.
 */

async function withVirtualAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return {
    credentials: async () =>
      (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials,
  };
}

async function reportPasskeysAvailable(page: Page) {
  await page.route('**/auth/passkeys/available', (route) =>
    route.fulfill({ json: { available: true } })
  );
}

test.describe('Passkeys', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'CDP virtual authenticator');

  test('add a passkey in Settings, sign out, sign in with it, then remove it', async ({ page }) => {
    const authenticator = await withVirtualAuthenticator(page);
    await reportPasskeysAvailable(page);
    const account = await provisionAccount({ emailPrefix: 'passkey' });
    await uiLogin(page, account.email, account.password);

    await page.goto('/settings?section=security');
    await expect(page.getByRole('heading', { name: /^passkeys$/i })).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByText(/no passkeys yet/i)).toBeVisible();
    await page.getByRole('button', { name: /add a passkey/i }).click();
    await page.getByLabel(/current password/i).fill(account.password);
    await page.getByRole('button', { name: /^continue$/i }).click();
    await expect(page.getByText(/passkey added/i)).toBeVisible({ timeout: 15000 });

    // The browser really made one — the negative control for "added" being a
    // message the page printed on its own.
    expect(await authenticator.credentials()).toHaveLength(1);
    await expect(
      page.getByRole('list', { name: /your passkeys/i }).getByRole('listitem')
    ).toHaveCount(1);

    // Sign out, then sign in with the passkey and no password.
    const hamburger = page.getByRole('button', { name: /open sidebar/i });
    if (await hamburger.isVisible()) await hamburger.click();
    await page
      .getByRole('button', { name: /sign out/i })
      .filter({ visible: true })
      .first()
      .click();
    await page.goto('/login');
    await page.getByLabel(/email/i).fill(account.email);
    await page.getByRole('button', { name: /use a passkey/i }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15000 });

    // Remove it; the list says so and the account signs in with a password again.
    await page.goto('/settings?section=security');
    await page.getByRole('button', { name: /remove passkey/i }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /remove passkey/i })
      .click();
    await expect(page.getByText(/passkey removed/i)).toBeVisible();
    await expect(page.getByText(/no passkeys yet/i)).toBeVisible();
  });

  test('an account with no passkey is told so, and the password still works', async ({ page }) => {
    await withVirtualAuthenticator(page);
    await reportPasskeysAvailable(page);
    const account = await provisionAccount({ emailPrefix: 'passkey-none' });

    await page.goto('/login');
    await page.getByLabel(/email/i).fill(account.email);
    await page.getByRole('button', { name: /use a passkey/i }).click();
    await expect(page.getByText(/no passkey for this account yet/i)).toBeVisible();
    await expect(page).toHaveURL(/\/login/);

    await uiLogin(page, account.email, account.password);
  });

  test('where the deployment has passkeys off, no passkey control is shown', async ({ page }) => {
    await withVirtualAuthenticator(page);
    // No probe override: the Playwright backend runs with passkeys off. Wait
    // for the page to have ASKED and been told "off" before judging absence,
    // so this cannot pass merely because the answer had not arrived yet.
    const probe = page.waitForResponse('**/auth/passkeys/available');
    await page.goto('/login');
    expect(await (await probe).json()).toEqual({ available: false });
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('button', { name: /use a passkey/i })).toHaveCount(0);
  });
});
