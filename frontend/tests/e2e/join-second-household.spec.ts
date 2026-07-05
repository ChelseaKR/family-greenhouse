import { test, expect, request as playwrightRequest } from '@playwright/test';
import { provisionAccount, uiLogin } from './helpers';

/**
 * Regression coverage for a bug where any user who already belonged to a
 * household (essentially everyone, since onboarding always creates one) was
 * silently redirected away from /join/:inviteCode before they could ever see
 * the invite — making it impossible to accept a second household's invite
 * through the app's only entry point for that flow. This drives the real,
 * intended flow end to end: two independent households, a real invite link,
 * and a second account (with its own existing household) accepting it.
 */

const API_URL = 'http://localhost:4000';

async function createInvite(idToken: string, householdId: string): Promise<string> {
  const api = await playwrightRequest.newContext();
  try {
    const res = await api.post(`${API_URL}/households/${householdId}/invites`, {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    expect(res.status(), 'invite creation should succeed').toBe(201);
    const { code } = (await res.json()) as { code: string };
    return code;
  } finally {
    await api.dispose();
  }
}

test('a user with an existing household can accept an invite to a second household', async ({
  page,
}) => {
  const inviter = await provisionAccount({
    emailPrefix: 'join-second-inviter',
    householdName: 'The Second House',
  });
  const joiner = await provisionAccount({ emailPrefix: 'join-second-joiner' });

  // Mint a real invite for the inviter's household via the API (no UI
  // dependency on where "create invite" lives in Household settings).
  const api = await playwrightRequest.newContext();
  const loginRes = await api.post(`${API_URL}/auth/login`, {
    data: { email: inviter.email, password: inviter.password },
  });
  const { idToken } = (await loginRes.json()) as { idToken: string };
  await api.dispose();
  const code = await createInvite(idToken, inviter.householdId);

  // Log in as the joiner — who already belongs to their OWN household —
  // then open the inviter's invite link.
  await uiLogin(page, joiner.email, joiner.password);
  await page.goto(`/join/${code}`);

  // Regression guard: this used to redirect straight to `/` because the
  // joiner already had a (different) household. Must show the real invite
  // screen instead.
  await expect(page.getByText('The Second House')).toBeVisible({ timeout: 15000 });
  await expect(page).not.toHaveURL(/\/dashboard$/);

  await page.getByRole('button', { name: /join household/i }).click();

  // Successful join lands back in the app (now scoped to the new household).
  await expect(page).toHaveURL(/^(?!.*\/join\/)/, { timeout: 15000 });

  // Confirm server-side: the joiner is now a member of BOTH households.
  const verify = await playwrightRequest.newContext();
  try {
    const meRes = await verify.post(`${API_URL}/auth/login`, {
      data: { email: joiner.email, password: joiner.password },
    });
    const { idToken: joinerToken } = (await meRes.json()) as { idToken: string };
    const householdsRes = await verify.get(`${API_URL}/me/households`, {
      headers: { Authorization: `Bearer ${joinerToken}` },
    });
    const memberships = (await householdsRes.json()) as Array<{ householdId: string }>;
    const ids = memberships.map((m) => m.householdId);
    expect(ids).toContain(joiner.householdId);
    expect(ids).toContain(inviter.householdId);
  } finally {
    await verify.dispose();
  }
});

test('a user who is already a member of the invited household sees a clear message, not a silent redirect', async ({
  page,
}) => {
  const account = await provisionAccount({
    emailPrefix: 'join-second-already-member',
    householdName: 'Already In Here',
  });

  const api = await playwrightRequest.newContext();
  const loginRes = await api.post(`${API_URL}/auth/login`, {
    data: { email: account.email, password: account.password },
  });
  const { idToken } = (await loginRes.json()) as { idToken: string };
  await api.dispose();
  const code = await createInvite(idToken, account.householdId);

  await uiLogin(page, account.email, account.password);
  await page.goto(`/join/${code}`);

  await expect(page.getByText(/already a member/i)).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('button', { name: /join household/i })).toHaveCount(0);
});
