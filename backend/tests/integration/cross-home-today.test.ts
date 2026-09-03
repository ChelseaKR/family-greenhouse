/**
 * Cross-home Today (`GET /me/today`, ADR 0017) against the mock dev server,
 * which mirrors handlers/me/today.ts + services/crossHomeToday.ts. Covers
 * what the unit tests can't: the real multi-membership shape (a second
 * household created through the API, a downgraded role on it), the plan
 * gate answering 402 rather than 404, the per-household grouping with the
 * home name on every row, a household whose row is gone coming back as an
 * explicit `unavailable` entry, and a row being acted on through an explicit
 * X-Household-Id for ITS home rather than the caller's default one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, db, resetDb, seedHouseholdId, seedTaskId, seedUserId } from '../../src/local-server';

const SEED_EMAIL = 'test@example.com';
const SEED_PASSWORD = 'password123';

async function loginAsSeed(): Promise<string> {
  const res = await request(app)
    .post('/auth/login')
    .send({ email: SEED_EMAIL, password: SEED_PASSWORD });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function createHousehold(token: string, name: string): Promise<string> {
  const res = await request(app)
    .post('/households')
    .set('Authorization', `Bearer ${token}`)
    .send({ name });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

/** A plant with one watering task in the addressed household; returns the task id. */
async function addPlantWithTask(
  token: string,
  householdId: string,
  plantName: string,
  nextDue: string
): Promise<string> {
  const plant = await request(app)
    .post('/plants')
    .set('Authorization', `Bearer ${token}`)
    .set('X-Household-Id', householdId)
    .send({ name: plantName });
  expect(plant.status).toBe(201);
  const task = await request(app)
    .post('/tasks')
    .set('Authorization', `Bearer ${token}`)
    .set('X-Household-Id', householdId)
    .send({ plantId: plant.body.id, type: 'water', frequency: 7, nextDue });
  expect(task.status).toBe(201);
  return task.body.id as string;
}

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function endOfLocalDay(): string {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

type Group =
  | {
      householdId: string;
      name: string;
      role: string;
      status: 'ok';
      tasks: Array<Record<string, unknown>>;
    }
  | { householdId: string; name: string | null; role: string; status: 'unavailable' };

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

describe('GET /me/today (cross-home Today, ADR 0017)', () => {
  it('requires auth', async () => {
    const res = await request(app).get('/me/today');
    expect(res.status).toBe(401);
  });

  it('is locked (402, not 404) until some household of the caller is on greenhouse', async () => {
    const token = await loginAsSeed();
    const res = await request(app).get('/me/today').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(402);
    expect(res.body.message).toMatch(/Greenhouse/);
  });

  it('groups due + overdue work by household, names every row, and resolves the role per household', async () => {
    const token = await loginAsSeed();
    const beachId = await createHousehold(token, 'Beach Cottage');
    db.households.get(seedHouseholdId)!.planId = 'greenhouse';
    const fernTaskId = await addPlantWithTask(token, beachId, 'Fern', daysFromNow(-2)); // overdue
    await addPlantWithTask(token, beachId, 'Cactus', daysFromNow(6)); // next week: not today
    // The caller is only a member at the cottage — the role must come from
    // THAT membership row, not from their admin default.
    db.users.get(seedUserId)!.memberships.find((m) => m.householdId === beachId)!.role = 'member';

    const res = await request(app)
      .get('/me/today')
      .query({ until: endOfLocalDay() })
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const groups = res.body.households as Group[];
    expect(groups).toHaveLength(2);

    const home = groups.find((g) => g.householdId === seedHouseholdId)!;
    expect(home).toMatchObject({ name: 'Test Household', role: 'admin', status: 'ok' });
    if (home.status !== 'ok') throw new Error('expected ok');
    expect(home.tasks.map((t) => t.id)).toContain(seedTaskId);
    for (const row of home.tasks) expect(row.householdName).toBe('Test Household');

    const beach = groups.find((g) => g.householdId === beachId)!;
    expect(beach).toMatchObject({ name: 'Beach Cottage', role: 'member', status: 'ok' });
    if (beach.status !== 'ok') throw new Error('expected ok');
    expect(beach.tasks.map((t) => t.id)).toEqual([fernTaskId]);
    expect(beach.tasks[0].householdName).toBe('Beach Cottage');
    expect(beach.tasks.some((t) => t.plantName === 'Cactus')).toBe(false);

    // Grouped, never merged: no flat list anywhere in the contract.
    expect(res.body.tasks).toBeUndefined();
  });

  it('rejects a cutoff that is not today', async () => {
    const token = await loginAsSeed();
    db.households.get(seedHouseholdId)!.planId = 'greenhouse';
    const farOff = await request(app)
      .get('/me/today')
      .query({ until: daysFromNow(10) })
      .set('Authorization', `Bearer ${token}`);
    expect(farOff.status).toBe(400);
    const garbage = await request(app)
      .get('/me/today')
      .query({ until: 'garbage' })
      .set('Authorization', `Bearer ${token}`);
    expect(garbage.status).toBe(400);
  });

  it('returns a household whose row is gone as an explicit unavailable entry, never dropping it', async () => {
    const token = await loginAsSeed();
    db.households.get(seedHouseholdId)!.planId = 'greenhouse';
    const goneId = await createHousehold(token, 'Gone Home');
    db.households.delete(goneId);

    const res = await request(app).get('/me/today').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const groups = res.body.households as Group[];
    expect(groups).toHaveLength(2);
    const gone = groups.find((g) => g.householdId === goneId)!;
    expect(gone).toEqual({ householdId: goneId, name: null, role: 'admin', status: 'unavailable' });
    expect(groups.find((g) => g.householdId === seedHouseholdId)).toMatchObject({ status: 'ok' });
  });

  it('follows the person: membership in ANY greenhouse household unlocks every home they belong to', async () => {
    const token = await loginAsSeed();
    const paidId = await createHousehold(token, 'Paid Home');
    db.households.get(paidId)!.planId = 'greenhouse';
    // The default (seed) household stays free.

    const res = await request(app).get('/me/today').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const ids = (res.body.households as Group[]).map((g) => g.householdId);
    expect(ids).toEqual(expect.arrayContaining([seedHouseholdId, paidId]));
  });

  it("acts on a row through an explicit X-Household-Id for that row's home", async () => {
    const token = await loginAsSeed();
    db.households.get(seedHouseholdId)!.planId = 'greenhouse';
    const beachId = await createHousehold(token, 'Beach Cottage');
    const fernTaskId = await addPlantWithTask(token, beachId, 'Fern', daysFromNow(-1));

    // Without the header the request lands on the caller's default household,
    // where this task does not exist — the header is load-bearing.
    const wrongHome = await request(app)
      .post(`/tasks/${fernTaskId}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(wrongHome.status).toBe(404);

    const rightHome = await request(app)
      .post(`/tasks/${fernTaskId}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Household-Id', beachId)
      .send({});
    expect(rightHome.status).toBe(200);

    const after = await request(app).get('/me/today').set('Authorization', `Bearer ${token}`);
    const beach = (after.body.households as Group[]).find((g) => g.householdId === beachId)!;
    if (beach.status !== 'ok') throw new Error('expected ok');
    expect(beach.tasks).toEqual([]);
  });
});
