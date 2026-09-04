/**
 * Member → admin upgrade request flow against the mock dev server (which
 * mirrors handlers/households/upgradeRequests.ts): a member of the seed
 * household asks for chat, the admin is resolved from the roster, the repeat
 * inside the week is refused with the retry date, and the ask shows up in
 * the household activity feed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, provisionLocalUserFixture, resetDb, seedHouseholdId } from '../../src/local-server';

const SEED_EMAIL = 'test@example.com';
const SEED_PASSWORD = 'password123';

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post('/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

/** A second person joins the seed household as a plain member via an invite. */
async function joinSeedHouseholdAsMember(adminToken: string): Promise<string> {
  provisionLocalUserFixture({ email: 'sam@example.com', password: 'password-123', name: 'Sam' });
  const invite = await request(app)
    .post(`/households/${seedHouseholdId}/invites`)
    .set('Authorization', `Bearer ${adminToken}`);
  expect(invite.status).toBe(201);
  const memberToken = await login('sam@example.com', 'password-123');
  const join = await request(app)
    .post(`/households/join/${invite.body.code}`)
    .set('Authorization', `Bearer ${memberToken}`);
  expect(join.status).toBe(200);
  return memberToken;
}

const originalLog = console.log;
const originalPayments = process.env.PAYMENTS_ENABLED;
beforeEach(() => {
  resetDb();
  console.log = () => {};
  process.env.PAYMENTS_ENABLED = '1';
});
afterEach(() => {
  console.log = originalLog;
  if (originalPayments === undefined) delete process.env.PAYMENTS_ENABLED;
  else process.env.PAYMENTS_ENABLED = originalPayments;
});

describe('POST /households/:id/upgrade-requests', () => {
  it('lets a member ask, names the admin, and records the ask in the activity feed', async () => {
    const adminToken = await login(SEED_EMAIL, SEED_PASSWORD);
    const memberToken = await joinSeedHouseholdAsMember(adminToken);

    const res = await request(app)
      .post(`/households/${seedHouseholdId}/upgrade-requests`)
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ feature: 'chat' });

    expect(res.status).toBe(201);
    expect(res.body.feature).toBe('chat');
    expect(res.body.targetPlanId).toBe('garden');
    expect(res.body.admins).toEqual([{ userId: expect.any(String), name: 'Test User' }]);
    // The dev server prints the email; nothing was sent and it says so.
    expect(res.body.emailDelivered).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('@example.com');

    const activity = await request(app)
      .get(`/households/${seedHouseholdId}/activity`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(activity.status).toBe(200);
    const ask = activity.body.find((e: { type: string }) => e.type === 'upgrade.requested');
    expect(ask).toMatchObject({
      actorName: 'Sam',
      payload: { feature: 'chat', plan: 'garden' },
    });
  });

  it('refuses a repeat for the same feature inside the week, with the retry date', async () => {
    const adminToken = await login(SEED_EMAIL, SEED_PASSWORD);
    const memberToken = await joinSeedHouseholdAsMember(adminToken);
    const first = await request(app)
      .post(`/households/${seedHouseholdId}/upgrade-requests`)
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ feature: 'chat' });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/households/${seedHouseholdId}/upgrade-requests`)
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ feature: 'chat' });
    expect(second.status).toBe(429);
    expect(second.body.details.nextAllowedAt).toBe(first.body.nextAllowedAt);

    // A different feature is a fresh ask.
    const other = await request(app)
      .post(`/households/${seedHouseholdId}/upgrade-requests`)
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ feature: 'api_keys' });
    expect(other.status).toBe(201);
    expect(other.body.targetPlanId).toBe('greenhouse');
  });

  it('409s an admin — they hold the real controls', async () => {
    const adminToken = await login(SEED_EMAIL, SEED_PASSWORD);
    const res = await request(app)
      .post(`/households/${seedHouseholdId}/upgrade-requests`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ feature: 'chat' });
    expect(res.status).toBe(409);
  });

  it('403s a household the caller is not acting in, and 400s an unknown feature', async () => {
    const adminToken = await login(SEED_EMAIL, SEED_PASSWORD);
    const memberToken = await joinSeedHouseholdAsMember(adminToken);
    const wrong = await request(app)
      .post('/households/11111111-1111-1111-1111-111111111111/upgrade-requests')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ feature: 'chat' });
    expect(wrong.status).toBe(403);

    const bad = await request(app)
      .post(`/households/${seedHouseholdId}/upgrade-requests`)
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ feature: 'please upgrade' });
    expect(bad.status).toBe(400);
  });

  it('503s while payments are paused — an ask nobody can act on is noise', async () => {
    const adminToken = await login(SEED_EMAIL, SEED_PASSWORD);
    const memberToken = await joinSeedHouseholdAsMember(adminToken);
    delete process.env.PAYMENTS_ENABLED;
    const res = await request(app)
      .post(`/households/${seedHouseholdId}/upgrade-requests`)
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ feature: 'chat' });
    expect(res.status).toBe(503);
  });
});
