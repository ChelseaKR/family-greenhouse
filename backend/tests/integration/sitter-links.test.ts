/**
 * End-to-end flows for no-account, time-boxed plant-sitter links against the
 * mock dev server (which mirrors the production handlers — see local-server.ts
 * contract note). Covers what the unit tests can't: the full create → public
 * view → public complete → revoke lifecycle, expiry + revocation rejection,
 * cross-household task rejection, the no-PII guarantee of the public payload,
 * and that the secret token is returned exactly once.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  app,
  db,
  provisionLocalUserFixture,
  resetDb,
  seedHouseholdId,
  seedPlantId,
  seedTaskId,
} from '../../src/local-server';

const SEED_EMAIL = 'test@example.com';
const SEED_PASSWORD = 'password123';

async function loginAsSeed(): Promise<string> {
  const res = await request(app)
    .post('/auth/login')
    .send({ email: SEED_EMAIL, password: SEED_PASSWORD });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

/** Direct local fixture → login → own household; returns the token. */
async function createUserWithHousehold(email: string, householdName: string): Promise<string> {
  provisionLocalUserFixture({ email, password: 'password-123', name: 'Neighbor' });
  const login = await request(app).post('/auth/login').send({ email, password: 'password-123' });
  expect(login.status).toBe(200);
  const token = login.body.accessToken as string;
  const hh = await request(app)
    .post('/households')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: householdName });
  expect(hh.status).toBe(201);
  return token;
}

function inFuture(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

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

describe('sitter link creation (authed)', () => {
  it('creates a link and returns the token + URL exactly once', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .post(`/households/${seedHouseholdId}/sitter-links`)
      .set('Authorization', `Bearer ${token}`)
      .send({ expiresAt: inFuture(7), label: "The Smiths' plants" });

    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^[0-9a-f]{64}$/); // 256-bit hex
    expect(res.body.url).toContain(`/sit/${res.body.token}`);
    expect(res.body.status).toBe('active');
    expect(res.body.label).toBe("The Smiths' plants");

    // The list view never re-exposes the token.
    const list = await request(app)
      .get(`/households/${seedHouseholdId}/sitter-links`)
      .set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].token).toBeUndefined();
    expect(list.body[0].id).toBe(res.body.id);
  });

  it('rejects an over-long window (> 60 days)', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .post(`/households/${seedHouseholdId}/sitter-links`)
      .set('Authorization', `Bearer ${token}`)
      .send({ expiresAt: inFuture(120) });
    expect(res.status).toBe(400);
  });

  it('rejects creation for a household the caller is not in (403)', async () => {
    const other = await createUserWithHousehold('neighbor@example.com', 'Neighbor House');
    const res = await request(app)
      .post(`/households/${seedHouseholdId}/sitter-links`)
      .set('Authorization', `Bearer ${other}`)
      .send({ expiresAt: inFuture(7) });
    expect(res.status).toBe(403);
  });
});

describe('public sitter view (no auth)', () => {
  async function createLink(): Promise<string> {
    const token = await loginAsSeed();
    const res = await request(app)
      .post(`/households/${seedHouseholdId}/sitter-links`)
      .set('Authorization', `Bearer ${token}`)
      .send({ expiresAt: inFuture(7), label: 'Our plants' });
    return res.body.token as string;
  }

  it('returns sitter-safe task locations with no private household data or auth header', async () => {
    const plant = db.plants.get(seedPlantId)!;
    plant.placementNote = 'east window, top shelf';
    plant.notes = 'Private propagation plan';
    db.tasks.get(seedTaskId)!.notes = 'Use the private measuring cup';
    db.households.get(seedHouseholdId)!.location = {
      city: 'Private Climate City',
      lat: 1,
      lon: 2,
    };
    const sitterToken = await createLink();
    const res = await request(app).get(`/sitter/${sitterToken}`); // no Authorization
    expect(res.status).toBe(200);

    expect(res.body.label).toBe('Our plants');
    expect(Array.isArray(res.body.tasks)).toBe(true);
    expect(res.body.tasks.length).toBeGreaterThan(0);

    const task = res.body.tasks[0];
    // Only the sitter-safe projection — exactly these keys, nothing more.
    expect(Object.keys(task).sort()).toEqual(
      ['dueDate', 'overdue', 'placementNote', 'plantName', 'spaceName', 'taskType', 'taskId'].sort()
    );
    expect(task.plantName).toBe('Monstera');
    expect(task.taskType).toBe('water');
    expect(task.spaceName).toBe('Living Room');
    expect(task.placementNote).toBe('east window, top shelf');

    // Assert the whole payload carries no member identity / household id / notes.
    const blob = JSON.stringify(res.body);
    expect(blob).not.toContain(SEED_EMAIL);
    expect(blob).not.toContain('Test User'); // seed member name
    expect(blob).not.toContain(seedHouseholdId);
    expect(blob).not.toContain('Private Climate City');
    expect(blob).not.toContain('Private propagation plan');
    expect(blob).not.toContain('Use the private measuring cup');
    expect(blob).not.toMatch(/assignedTo|completedBy|createdBy|"notes"|email/);
  });

  it('404s on an unknown / malformed token (no enumeration oracle)', async () => {
    const bad = await request(app).get('/sitter/not-a-real-token');
    expect(bad.status).toBe(404);
    const wrongLen = await request(app).get(`/sitter/${'a'.repeat(64)}`);
    expect(wrongLen.status).toBe(404);
    // The two messages are identical — no way to tell "malformed" from "absent".
    expect(bad.body.message).toBe(wrongLen.body.message);
  });

  it('410-equivalent: rejects an expired link', async () => {
    const sitterToken = await createLink();
    // Force expiry by rewinding the stored window into the past.
    const link = db.sitterLinks.get(sitterToken)!;
    link.expiresAt = new Date(Date.now() - 1000).toISOString();
    const res = await request(app).get(`/sitter/${sitterToken}`);
    expect(res.status).toBe(404);
  });

  it('rejects a link whose window has not started yet', async () => {
    const sitterToken = await createLink();
    const link = db.sitterLinks.get(sitterToken)!;
    link.startsAt = inFuture(2);
    const res = await request(app).get(`/sitter/${sitterToken}`);
    expect(res.status).toBe(404);
  });

  it('rejects a revoked link', async () => {
    const adminToken = await loginAsSeed();
    const created = await request(app)
      .post(`/households/${seedHouseholdId}/sitter-links`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ expiresAt: inFuture(7) });
    const sitterToken = created.body.token as string;
    const linkId = created.body.id as string;

    const del = await request(app)
      .delete(`/households/${seedHouseholdId}/sitter-links/${linkId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(del.status).toBe(204);

    const res = await request(app).get(`/sitter/${sitterToken}`);
    expect(res.status).toBe(404);
  });
});

describe('public sitter completion (no auth)', () => {
  async function createLink(): Promise<string> {
    const adminToken = await loginAsSeed();
    const res = await request(app)
      .post(`/households/${seedHouseholdId}/sitter-links`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ expiresAt: inFuture(7) });
    return res.body.token as string;
  }

  it('completes a task and attributes it to "a plant sitter"', async () => {
    const sitterToken = await createLink();
    const res = await request(app).post(`/sitter/${sitterToken}/tasks/${seedTaskId}/complete`);
    expect(res.status).toBe(200);
    expect(res.body.taskId).toBe(seedTaskId);
    expect(res.body.overdue).toBe(false);

    // A completion + activity row landed, attributed to the sitter (no member).
    const completion = [...db.completions.values()].find((c) => c.taskId === seedTaskId);
    expect(completion?.completedByName).toBe('a plant sitter');
    expect(completion?.completedBy).toMatch(/^sitter:/);
  });

  it('rejects completing a task from ANOTHER household (cross-household guard)', async () => {
    // A second household with its own plant + task.
    const otherToken = await createUserWithHousehold('other@example.com', 'Other House');
    const plant = await request(app)
      .post('/plants')
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ name: 'Fern' });
    const otherTask = await request(app)
      .post('/tasks')
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ plantId: plant.body.id, type: 'water', frequency: 7 });
    expect(otherTask.status).toBe(201);

    // A sitter link scoped to the SEED household must not be able to complete
    // the OTHER household's task.
    const sitterToken = await createLink();
    const res = await request(app).post(
      `/sitter/${sitterToken}/tasks/${otherTask.body.id}/complete`
    );
    expect(res.status).toBe(404);
  });

  it('404s completion on an expired link', async () => {
    const sitterToken = await createLink();
    db.sitterLinks.get(sitterToken)!.expiresAt = new Date(Date.now() - 1000).toISOString();
    const res = await request(app).post(`/sitter/${sitterToken}/tasks/${seedTaskId}/complete`);
    expect(res.status).toBe(404);
  });
});
