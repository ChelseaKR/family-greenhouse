/**
 * Critical-path integration test: provisioned user → household → first plant
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
import { app, provisionLocalUserFixture, resetDb } from '../../src/local-server';

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

describe('critical path: provision → household → plant → task → complete', () => {
  it('walks a provisioned user through the whole first-session flow', async () => {
    // Public signup is closed during the commercial hold. A direct local-only
    // fixture mirrors Cognito AdminCreateUser used by the deployed smoke test.
    provisionLocalUserFixture({
      email: NEW_EMAIL,
      password: NEW_PASSWORD,
      name: NEW_NAME,
    });

    // 1. Login — user is confirmed but has no household yet.
    const login = await request(app)
      .post('/auth/login')
      .send({ email: NEW_EMAIL, password: NEW_PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.idToken).toBeTruthy();
    expect(login.body.accessToken).toBeTruthy();
    expect(login.body.refreshToken).toBeTruthy();
    expect(typeof login.body.expiresIn).toBe('number');
    expect(login.body.user.householdId).toBeNull();
    const token = login.body.accessToken as string;

    // 2. Create the first household. This is the step where the real
    //    Cognito-claim regression hit — make sure the immediately-following
    //    request sees the household.
    const householdRes = await request(app)
      .post('/households')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Critical Path Household' });
    expect(householdRes.status).toBe(201);
    expect(householdRes.body.id).toBeTruthy();
    const householdId = householdRes.body.id as string;

    // 3. The very next request after household creation — fetching the
    //    user's own household — must succeed without re-authenticating.
    //    A 403 here means the household claim never propagated.
    const meHousehold = await request(app)
      .get(`/households/${householdId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(meHousehold.status).toBe(200);
    expect(meHousehold.body.id).toBe(householdId);

    // 4. Add the user's first plant. The create schema requires `name` —
    //    a body missing it (e.g. legacy `nickname`) is a Zod 400 in
    //    production, never a silent 201.
    const badPlant = await request(app)
      .post('/plants')
      .set('Authorization', `Bearer ${token}`)
      .send({ nickname: 'Bertha', species: 'Monstera deliciosa' });
    expect(badPlant.status).toBe(400);
    expect(badPlant.body.message).toBe('Validation failed');
    expect(badPlant.body.details).toHaveProperty('name');

    const plant = await request(app).post('/plants').set('Authorization', `Bearer ${token}`).send({
      name: 'Bertha',
      species: 'Monstera deliciosa',
      location: 'Living room',
    });
    expect(plant.status).toBe(201);
    expect(plant.body.id).toBeTruthy();
    const plantId = plant.body.id as string;

    // 5. Plant listing should include the new plant.
    const plants = await request(app).get('/plants').set('Authorization', `Bearer ${token}`);
    expect(plants.status).toBe(200);
    expect(plants.body.map((p: { id: string }) => p.id)).toContain(plantId);

    // 6. Create a recurring watering task for the plant.
    const task = await request(app).post('/tasks').set('Authorization', `Bearer ${token}`).send({
      plantId,
      type: 'water',
      frequency: 7, // every 7 days
    });
    expect(task.status).toBe(201);
    expect(task.body.id).toBeTruthy();
    const taskId = task.body.id as string;

    // 7. Mark it complete.
    const complete = await request(app)
      .post(`/tasks/${taskId}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(complete.status).toBe(200);

    // 8. Activity feed reflects the completion (this is the dashboard's
    //     Recent Activity panel — the one that was blank in the bug report).
    const activity = await request(app)
      .get(`/households/${householdId}/activity`)
      .set('Authorization', `Bearer ${token}`);
    expect(activity.status).toBe(200);
    expect(Array.isArray(activity.body)).toBe(true);
    const types = (activity.body as Array<{ type: string }>).map((a) => a.type);
    expect(types).toContain('task.completed');
  });

  it('403s a fresh, householdless user on /plants (requireHousehold, no leak)', async () => {
    provisionLocalUserFixture({
      email: NEW_EMAIL,
      password: NEW_PASSWORD,
      name: NEW_NAME,
    });
    const login = await request(app)
      .post('/auth/login')
      .send({ email: NEW_EMAIL, password: NEW_PASSWORD });
    const token = login.body.accessToken as string;

    // Production enforces requireHousehold on every plant route: a brand-new
    // user without a household gets a 403 — and certainly never sees anyone
    // else's plants.
    const plants = await request(app).get('/plants').set('Authorization', `Bearer ${token}`);
    expect(plants.status).toBe(403);
    expect(plants.body.message).toBe('User must belong to a household');
  });

  it('rejects login when the password is wrong without leaking account existence', async () => {
    provisionLocalUserFixture({
      email: NEW_EMAIL,
      password: NEW_PASSWORD,
      name: NEW_NAME,
    });

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
