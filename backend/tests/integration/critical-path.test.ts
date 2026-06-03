/**
 * Critical-path integration test: brand-new user → household → first plant
 * → first task → completion.
 *
 * Asserts the WHOLE flow a new signup walks through. This is the test that
 * would have caught the 2026-05-31 token-claim regression: the bug only
 * manifested across the boundary between login, household creation, and the
 * very next post-login request that needed `custom:household_id`.
 *
 * Runs against `local-server` (the in-process supertest harness), not real
 * AWS — for that, see the Playwright e2e in tests/e2e/.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, resetDb } from '../../src/local-server';

const NEW_EMAIL = 'new-user@example.com';
const NEW_PASSWORD = 'StrongPass123!';
const NEW_NAME = 'New User';

beforeEach(() => {
  resetDb();
});

const originalLog = console.log;
beforeEach(() => {
  console.log = () => {};
});
afterEach(() => {
  console.log = originalLog;
});

describe('critical path: signup → household → plant → task → complete', () => {
  it('walks a brand new user through the whole first-session flow', async () => {
    // 1. Signup
    const signup = await request(app)
      .post('/auth/signup')
      .send({ email: NEW_EMAIL, password: NEW_PASSWORD, name: NEW_NAME });
    expect(signup.status).toBe(201);

    // 2. Confirm with the well-known dev code (local-server uses 123456).
    const confirm = await request(app)
      .post('/auth/confirm')
      .send({ email: NEW_EMAIL, code: '123456' });
    expect(confirm.status).toBe(200);
    expect(confirm.body.user.email).toBe(NEW_EMAIL);
    expect(confirm.body.user.householdId).toBeNull();

    // 3. Login — user is confirmed but has no household yet.
    const login = await request(app)
      .post('/auth/login')
      .send({ email: NEW_EMAIL, password: NEW_PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.accessToken).toBeTruthy();
    expect(login.body.refreshToken).toBeTruthy();
    expect(login.body.user.householdId).toBeNull();
    const token = login.body.accessToken as string;

    // 4. Create the first household. This is the step where the real
    //    Cognito-claim regression hit — make sure the immediately-following
    //    request sees the household.
    const householdRes = await request(app)
      .post('/households')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Critical Path Household' });
    expect(householdRes.status).toBe(201);
    expect(householdRes.body.id).toBeTruthy();
    const householdId = householdRes.body.id as string;

    // 5. The very next request after household creation — fetching the
    //    user's own household — must succeed without re-authenticating.
    //    A 403 here means the household claim never propagated.
    const meHousehold = await request(app)
      .get(`/households/${householdId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(meHousehold.status).toBe(200);
    expect(meHousehold.body.id).toBe(householdId);

    // 6. Add the user's first plant.
    const plant = await request(app).post('/plants').set('Authorization', `Bearer ${token}`).send({
      nickname: 'Bertha',
      species: 'Monstera deliciosa',
      location: 'Living room',
    });
    expect(plant.status).toBe(201);
    expect(plant.body.id).toBeTruthy();
    const plantId = plant.body.id as string;

    // 7. Plant listing should include the new plant.
    const plants = await request(app).get('/plants').set('Authorization', `Bearer ${token}`);
    expect(plants.status).toBe(200);
    expect(plants.body.map((p: { id: string }) => p.id)).toContain(plantId);

    // 8. Create a recurring watering task for the plant.
    const task = await request(app).post('/tasks').set('Authorization', `Bearer ${token}`).send({
      plantId,
      type: 'water',
      frequency: 7, // every 7 days
    });
    expect(task.status).toBe(201);
    expect(task.body.id).toBeTruthy();
    const taskId = task.body.id as string;

    // 9. Mark it complete.
    const complete = await request(app)
      .post(`/tasks/${taskId}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(complete.status).toBe(200);

    // 10. Activity feed reflects the completion (this is the dashboard's
    //     Recent Activity panel — the one that was blank in the bug report).
    const activity = await request(app)
      .get(`/households/${householdId}/activity`)
      .set('Authorization', `Bearer ${token}`);
    expect(activity.status).toBe(200);
    expect(Array.isArray(activity.body)).toBe(true);
    const types = (activity.body as Array<{ type: string }>).map((a) => a.type);
    expect(types).toContain('task.completed');
  });

  it('returns an empty plant list to a fresh, householdless user (no leak across households)', async () => {
    // Signup, confirm, login — no household yet.
    await request(app)
      .post('/auth/signup')
      .send({ email: NEW_EMAIL, password: NEW_PASSWORD, name: NEW_NAME });
    await request(app).post('/auth/confirm').send({ email: NEW_EMAIL, code: '123456' });
    const login = await request(app)
      .post('/auth/login')
      .send({ email: NEW_EMAIL, password: NEW_PASSWORD });
    const token = login.body.accessToken as string;

    // local-server filters by household-id-or-undefined; the production
    // Lambda enforces requireHousehold and returns 403 (see Playwright e2e
    // for the production-behavior assertion). Either way: a brand-new user
    // must NOT see anyone else's plants.
    const plants = await request(app).get('/plants').set('Authorization', `Bearer ${token}`);
    expect(plants.status).toBe(200);
    expect(plants.body).toEqual([]);
  });

  it('rejects login when the password is wrong without leaking account existence', async () => {
    await request(app)
      .post('/auth/signup')
      .send({ email: NEW_EMAIL, password: NEW_PASSWORD, name: NEW_NAME });
    await request(app).post('/auth/confirm').send({ email: NEW_EMAIL, code: '123456' });

    const bad = await request(app)
      .post('/auth/login')
      .send({ email: NEW_EMAIL, password: 'wrong-password' });
    expect(bad.status).toBe(401);
    // Generic 'Invalid email or password' — never reveal whether the
    // account exists.
    expect(bad.body.message).toMatch(/invalid/i);

    const noSuch = await request(app)
      .post('/auth/login')
      .send({ email: 'no-such-user@example.com', password: 'anything' });
    expect(noSuch.status).toBe(401);
    expect(noSuch.body.message).toMatch(/invalid/i);
  });
});
