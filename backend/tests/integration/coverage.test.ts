/**
 * GET /households/:id/analytics/coverage against the mock dev server — the
 * same pure `computeCoverage` the Lambda handler uses, fed from the in-memory
 * tables. Covers the gate, the household-of-one state, the sole-caregiver
 * list and an upcoming vacation window, end to end through Express.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, db, resetDb, seedHouseholdId, seedPlantId, seedUserId } from '../../src/local-server';

const SEED_EMAIL = 'test@example.com';
const SEED_PASSWORD = 'password123';
// The vacation schema requires UUID member ids.
const SAM_ID = '550e8400-e29b-41d4-a716-446655440077';

async function loginAsSeed(): Promise<string> {
  const res = await request(app)
    .post('/auth/login')
    .send({ email: SEED_EMAIL, password: SEED_PASSWORD });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

function seedMember(id: string, name: string, role: 'admin' | 'member' = 'member'): void {
  db.users.set(id, {
    id,
    email: `${id}@example.com`,
    password: 'password-123',
    name,
    confirmed: true,
    householdId: seedHouseholdId,
    householdRole: role,
    memberships: [{ householdId: seedHouseholdId, role, joinedAt: new Date().toISOString() }],
  } as never);
}

function seedCompletion(plantId: string, completedBy: string, completedByName: string): void {
  const id = `c-${plantId}-${completedBy}-${db.completions.size}`;
  db.completions.set(id, {
    id,
    householdId: seedHouseholdId,
    plantId,
    taskId: 't-x',
    taskType: 'water',
    completedBy,
    completedByName,
    completedAt: new Date().toISOString(),
    notes: null,
  });
}

function seedPlant(id: string, name: string, status: 'active' | 'died' = 'active'): void {
  db.plants.set(id, {
    ...db.plants.get(seedPlantId)!,
    id,
    name,
    status,
  });
}

const originalLog = console.log;
beforeEach(() => {
  resetDb();
  console.log = () => {};
});
afterEach(() => {
  console.log = originalLog;
});

describe('GET /households/:id/analytics/coverage', () => {
  it('is gated to the household toolkit: 402 on Seedling', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .get(`/households/${seedHouseholdId}/analytics/coverage`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(402);
    expect(res.body.message).toMatch(/Garden plan/);
  });

  it('refuses another household id', async () => {
    db.households.get(seedHouseholdId)!.planId = 'garden';
    const token = await loginAsSeed();
    const res = await request(app)
      .get('/households/00000000-0000-0000-0000-000000000000/analytics/coverage')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('reports a household of one honestly: one member, every cared-for plant on them', async () => {
    db.households.get(seedHouseholdId)!.planId = 'garden';
    seedCompletion(seedPlantId, seedUserId, 'Test User');
    const token = await loginAsSeed();
    const res = await request(app)
      .get(`/households/${seedHouseholdId}/analytics/coverage`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.memberCount).toBe(1);
    expect(res.body.plantCount).toBe(1);
    expect(res.body.soleCaregiverPlants.map((p: { plantId: string }) => p.plantId)).toEqual([
      seedPlantId,
    ]);
    expect(res.body.awayRisks).toEqual([]);
  });

  it('lists the plants resting on one person, by name, and excludes retired plants and sitters', async () => {
    db.households.get(seedHouseholdId)!.planId = 'greenhouse';
    seedMember(SAM_ID, 'Sam');
    seedPlant('p-fern', 'Fern');
    seedPlant('p-aloe', 'Aloe');
    seedPlant('p-dead', 'Cactus', 'died');
    // Monstera: both. Fern: only the seed user. Aloe: only a sitter. Cactus: retired.
    seedCompletion(seedPlantId, seedUserId, 'Test User');
    seedCompletion(seedPlantId, SAM_ID, 'Sam');
    seedCompletion('p-fern', seedUserId, 'Test User');
    seedCompletion('p-aloe', 'sitter:link-1', 'a plant sitter');
    seedCompletion('p-dead', seedUserId, 'Test User');

    const token = await loginAsSeed();
    const res = await request(app)
      .get(`/households/${seedHouseholdId}/analytics/coverage`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.memberCount).toBe(2);
    expect(res.body.plants.map((p: { plantName: string }) => p.plantName)).toEqual([
      'Aloe',
      'Fern',
      'Monstera',
    ]);
    expect(
      res.body.soleCaregiverPlants.map(
        (p: { plantName: string; soleCaregiver: { name: string } }) => [
          p.plantName,
          p.soleCaregiver.name,
        ]
      )
    ).toEqual([['Fern', 'Test User']]);
    expect(res.body.uncaredPlantCount).toBe(1);
    // Members are names and ids only — no totals ride on them.
    for (const m of res.body.members as Array<Record<string, unknown>>) {
      expect(Object.keys(m).sort()).toEqual(['name', 'userId']);
    }
  });

  it('turns an upcoming vacation window into "N plants have no one else"', async () => {
    db.households.get(seedHouseholdId)!.planId = 'garden';
    seedMember(SAM_ID, 'Sam');
    seedPlant('p-fern', 'Fern');
    seedCompletion(seedPlantId, seedUserId, 'Test User');
    seedCompletion('p-fern', seedUserId, 'Test User');
    seedCompletion('p-fern', SAM_ID, 'Sam');

    const token = await loginAsSeed();
    const start = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    const end = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
    const set = await request(app)
      .put('/tasks/vacation')
      .set('Authorization', `Bearer ${token}`)
      .send({ coveredBy: SAM_ID, startDate: start, endDate: end });
    expect(set.status).toBe(200);

    const res = await request(app)
      .get(`/households/${seedHouseholdId}/analytics/coverage`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.awayRisks).toHaveLength(1);
    expect(res.body.awayRisks[0]).toMatchObject({
      userId: seedUserId,
      name: 'Test User',
      coveredBy: SAM_ID,
      coveredByName: 'Sam',
      active: false,
      uncoveredPlantCount: 1,
      uncoveredPlants: [{ plantId: seedPlantId, plantName: 'Monstera' }],
    });
  });
});
