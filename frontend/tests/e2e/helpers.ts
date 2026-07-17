import { expect, request as playwrightRequest, Page } from '@playwright/test';

/**
 * Shared e2e helpers.
 *
 * Two problems these solve:
 *
 * 1. **Shared-state collisions.** The local backend boots one in-memory DB
 *    that every project (chromium, firefox, webkit, both mobile devices)
 *    shares for the whole run. Specs that mutate the well-known seed
 *    account (test@example.com) race each other across projects — e.g.
 *    completing the seeded water task in one project breaks another
 *    project's "task is due today" assertion. `provisionAccount` gives a
 *    spec its own directly provisioned local-only user + household (+ optional
 *    plant and water task) so mutations stay isolated without reopening the
 *    public signup route during the commercial hold.
 *
 * 2. **Mobile navigation.** On mobile viewports the sidebar nav links sit
 *    behind the "Open sidebar" hamburger, so a bare
 *    `getByRole('link').click()` times out. `navigateTo` opens the drawer
 *    when needed and, after navigating, waits for the drawer's self-close
 *    (NavLink onNavigate) to finish before returning.
 */

const API_URL = 'http://localhost:4000';

export interface ProvisionedAccount {
  email: string;
  password: string;
  name: string;
  householdId: string;
  spaceId?: string;
  plantId?: string;
  taskId?: string;
}

let provisionCounter = 0;

export async function provisionAccount(opts: {
  /** Goes into the unique email so failures are attributable to a spec. */
  emailPrefix: string;
  /** Display name; defaults to the seed account's "Test User". */
  name?: string;
  householdName?: string;
  space?: {
    name: string;
    environment: 'inside' | 'outside';
    rainExposure?: 'exposed' | 'sheltered';
    lightLevel?: 'low' | 'medium' | 'bright';
    petAccess?: boolean;
  };
  plant?: { name: string; species?: string; location?: string; notes?: string };
  /** Requires `plant`. `nextDue` defaults to "now" (today bucket). */
  waterTask?: { frequency?: number; nextDue?: string };
}): Promise<ProvisionedAccount> {
  const unique = `${Date.now()}-${process.pid}-${provisionCounter++}-${Math.floor(
    Math.random() * 1e6
  )}`;
  const email = `${opts.emailPrefix}-${unique}@example.com`;
  const password = 'password123';
  const name = opts.name ?? 'Test User';

  const api = await playwrightRequest.newContext();
  try {
    let res = await api.post(`${API_URL}/__test__/accounts`, { data: { email, password, name } });
    expect(res.status(), 'local test provisioning should succeed').toBe(201);

    res = await api.post(`${API_URL}/auth/login`, { data: { email, password } });
    expect(res.ok(), 'login should succeed').toBeTruthy();
    const { idToken } = (await res.json()) as { idToken: string };
    const headers = { Authorization: `Bearer ${idToken}` };

    res = await api.post(`${API_URL}/households`, {
      headers,
      data: { name: opts.householdName ?? 'Test Household' },
    });
    expect(res.status(), 'household creation should succeed').toBe(201);
    const household = (await res.json()) as { id: string };

    const account: ProvisionedAccount = {
      email,
      password,
      name,
      householdId: household.id,
    };

    if (opts.space) {
      res = await api.post(`${API_URL}/spaces`, { headers, data: opts.space });
      expect(res.status(), 'space creation should succeed').toBe(201);
      account.spaceId = ((await res.json()) as { id: string }).id;
    }

    if (opts.plant) {
      res = await api.post(`${API_URL}/plants`, {
        headers,
        data: { ...opts.plant, ...(account.spaceId ? { spaceId: account.spaceId } : {}) },
      });
      expect(res.status(), 'plant creation should succeed').toBe(201);
      const plant = (await res.json()) as { id: string };
      account.plantId = plant.id;

      if (opts.waterTask) {
        res = await api.post(`${API_URL}/tasks`, {
          headers,
          data: {
            plantId: plant.id,
            type: 'water',
            frequency: opts.waterTask.frequency ?? 7,
            ...(opts.waterTask.nextDue ? { nextDue: opts.waterTask.nextDue } : {}),
          },
        });
        expect(res.status(), 'task creation should succeed').toBe(201);
        account.taskId = ((await res.json()) as { id: string }).id;
      }
    }

    return account;
  } finally {
    await api.dispose();
  }
}

/** Log in through the UI form (avoids the zustand-persist goto race). */
export async function uiLogin(page: Page, email = 'test@example.com', password = 'password123') {
  await page.goto('/login');
  const emailField = page.getByLabel(/email/i);
  await emailField.waitFor({ state: 'visible', timeout: 15000 });
  await emailField.fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 15000 });
}

/**
 * Click a sidebar nav link, opening/closing the mobile drawer when the
 * viewport requires it, and wait for the URL to change. Mobile navigation
 * closes the drawer through `Layout`'s link handler; waiting for that exit
 * avoids racing the closing transition and clicking a now-offscreen control.
 */
export async function navigateTo(page: Page, linkName: RegExp, urlPattern: RegExp) {
  const hamburger = page.getByRole('button', { name: /open sidebar/i });
  const visibleHamburger = hamburger.filter({ visible: true });
  const visibleLink = page.getByRole('link', { name: linkName }).filter({ visible: true });
  // Wait for the app shell to be interactive before deciding which layout
  // we're in: on desktop the sidebar link is visible, on mobile only the
  // hamburger is. Checking `hamburger.isVisible()` immediately races the
  // lazy-loaded shell and can misdetect mobile as desktop.
  await expect(visibleHamburger.or(visibleLink).first()).toBeVisible({ timeout: 15000 });
  const isMobile = await hamburger.isVisible();
  if (isMobile) {
    await hamburger.click();
  }
  await visibleLink.first().click();
  await expect(page).toHaveURL(urlPattern, { timeout: 15000 });
  if (isMobile) {
    // The drawer closes itself on nav (NavLink onNavigate). Under
    // react-router 7 the navigation commits inside React.startTransition,
    // so the close runs to completion and a manual dismiss click races
    // the Dialog unmount ("element was detached from the DOM"); wait for
    // the leave transition to finish instead.
    await page.getByRole('button', { name: /close sidebar/i }).waitFor({ state: 'hidden' });
  }
}
