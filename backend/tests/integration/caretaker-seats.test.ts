/**
 * End-to-end flows for caretaker seats against the mock dev server (which
 * mirrors the production handlers — see the local-server.ts contract note).
 *
 * The three things these tests exist to hold still:
 *
 *   1. **The plan gate.** Creating a seat is Greenhouse-only; seeing, revoking
 *      and reporting on seats you already have is not, because trapping a live
 *      credential behind a paywall is a security bug.
 *   2. **The permission surface.** A caretaker token opens exactly five routes
 *      and nothing else. The negative assertions here are the test of that
 *      claim — a future route added under /caretaker/ without an ADR change
 *      should make one of them fail.
 *   3. **Attribution and the visit record.** Every action carries the
 *      caretaker's NAME (not "a plant sitter"), and the report's arrival time
 *      is the first action's timestamp rather than anything self-declared.
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

/** Put the seed household on the tier that includes caretaker seats. */
function entitleSeedHousehold(): void {
  db.households.get(seedHouseholdId)!.planId = 'greenhouse';
}

async function createSeat(auth: string, name = 'Dana'): Promise<{ id: string; token: string }> {
  const res = await request(app)
    .post(`/households/${seedHouseholdId}/caretakers`)
    .set('Authorization', `Bearer ${auth}`)
    .send({ name, expiresAt: inFuture(14) });
  expect(res.status).toBe(201);
  return { id: res.body.id, token: res.body.token };
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

describe('caretaker seat creation (authed)', () => {
  it('refuses to create a seat on a plan without the feature', async () => {
    const auth = await loginAsSeed();
    const res = await request(app)
      .post(`/households/${seedHouseholdId}/caretakers`)
      .set('Authorization', `Bearer ${auth}`)
      .send({ name: 'Dana', expiresAt: inFuture(14) });
    expect(res.status).toBe(402);
    expect(res.body.message).toMatch(/Greenhouse/);
  });

  it('creates a named seat and returns the token + URL exactly once', async () => {
    entitleSeedHousehold();
    const auth = await loginAsSeed();
    const res = await request(app)
      .post(`/households/${seedHouseholdId}/caretakers`)
      .set('Authorization', `Bearer ${auth}`)
      .send({ name: 'Dana', expiresAt: inFuture(14) });

    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^[0-9a-f]{64}$/); // 256-bit hex
    expect(res.body.url).toContain(`/caretaker/${res.body.token}`);
    expect(res.body.name).toBe('Dana');
    expect(res.body.status).toBe('active');
    // The seat publishes its own permission surface, so the household can see
    // the limits rather than take them on faith.
    expect(res.body.permissions).toEqual(['task.complete', 'photo.add', 'note.add']);

    const list = await request(app)
      .get(`/households/${seedHouseholdId}/caretakers`)
      .set('Authorization', `Bearer ${auth}`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].token).toBeUndefined();
    expect(list.body[0].name).toBe('Dana');
  });

  it('rejects an unnamed seat — attribution is the point of the feature', async () => {
    entitleSeedHousehold();
    const auth = await loginAsSeed();
    const res = await request(app)
      .post(`/households/${seedHouseholdId}/caretakers`)
      .set('Authorization', `Bearer ${auth}`)
      .send({ expiresAt: inFuture(14) });
    expect(res.status).toBe(400);
  });

  it('rejects a window longer than the 180-day ceiling', async () => {
    entitleSeedHousehold();
    const auth = await loginAsSeed();
    const res = await request(app)
      .post(`/households/${seedHouseholdId}/caretakers`)
      .set('Authorization', `Bearer ${auth}`)
      .send({ name: 'Dana', expiresAt: inFuture(400) });
    expect(res.status).toBe(400);
  });

  it('keeps list and revoke reachable after a downgrade', async () => {
    entitleSeedHousehold();
    const auth = await loginAsSeed();
    const seat = await createSeat(auth);

    // Downgrade. The credential is still live, so the controls that stop it
    // must still work — a paywall in front of revoke would be a security bug.
    db.households.get(seedHouseholdId)!.planId = 'seedling';

    const list = await request(app)
      .get(`/households/${seedHouseholdId}/caretakers`)
      .set('Authorization', `Bearer ${auth}`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);

    const revoke = await request(app)
      .delete(`/households/${seedHouseholdId}/caretakers/${seat.id}`)
      .set('Authorization', `Bearer ${auth}`);
    expect(revoke.status).toBe(204);
  });
});

describe('caretaker public surface', () => {
  it('shows the caretaker their name, window, permissions and due tasks', async () => {
    entitleSeedHousehold();
    const auth = await loginAsSeed();
    const seat = await createSeat(auth);

    const view = await request(app).get(`/caretaker/${seat.token}`);
    expect(view.status).toBe(200);
    expect(view.body.caretakerName).toBe('Dana');
    expect(view.body.permissions).toEqual(['task.complete', 'photo.add', 'note.add']);
    expect(Array.isArray(view.body.tasks)).toBe(true);

    // The projection carries care directions and the opaque plant id (needed
    // to attach a photo) — and no member identity or household internals.
    for (const task of view.body.tasks) {
      expect(Object.keys(task).sort()).toEqual(
        [
          'dueDate',
          'overdue',
          'placementNote',
          'plantId',
          'plantName',
          'spaceName',
          'taskId',
          'taskType',
        ].sort()
      );
    }
  });

  it('answers one generic 404 for malformed, unknown, expired and revoked tokens', async () => {
    entitleSeedHousehold();
    const auth = await loginAsSeed();
    const seat = await createSeat(auth);

    const malformed = await request(app).get('/caretaker/not-a-token');
    const unknown = await request(app).get(`/caretaker/${'a'.repeat(64)}`);
    expect(malformed.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(malformed.body.message).toBe(unknown.body.message);

    await request(app)
      .delete(`/households/${seedHouseholdId}/caretakers/${seat.id}`)
      .set('Authorization', `Bearer ${auth}`);
    const revoked = await request(app).get(`/caretaker/${seat.token}`);
    expect(revoked.status).toBe(404);
    expect(revoked.body.message).toBe(unknown.body.message);
  });

  it('refuses a seat whose window has not opened yet', async () => {
    entitleSeedHousehold();
    const auth = await loginAsSeed();
    const res = await request(app)
      .post(`/households/${seedHouseholdId}/caretakers`)
      .set('Authorization', `Bearer ${auth}`)
      .send({ name: 'Dana', startsAt: inFuture(3), expiresAt: inFuture(10) });
    expect(res.status).toBe(201);
    const view = await request(app).get(`/caretaker/${res.body.token}`);
    expect(view.status).toBe(404);
  });

  it('attributes a completion to the caretaker by name, not "a plant sitter"', async () => {
    entitleSeedHousehold();
    const auth = await loginAsSeed();
    const seat = await createSeat(auth);

    const done = await request(app).post(`/caretaker/${seat.token}/tasks/${seedTaskId}/complete`);
    expect(done.status).toBe(200);
    expect(done.body.visitRecorded).toBe(true);

    const completion = [...db.completions.values()].find((c) => c.taskId === seedTaskId);
    expect(completion?.completedByName).toBe('Dana');
    expect(completion?.completedBy).toBe(`caretaker:${seat.id}`);

    const event = [...db.activity.values()].find((e) => e.type === 'task.completed');
    expect(event?.actorName).toBe('Dana');
    expect((event?.payload as { viaCaretaker?: boolean }).viaCaretaker).toBe(true);
  });

  it('cannot reach another household’s task', async () => {
    entitleSeedHousehold();
    const auth = await loginAsSeed();
    const seat = await createSeat(auth);

    const otherAuth = await createUserWithHousehold('neighbour@example.com', 'Next door');
    const plant = await request(app)
      .post('/plants')
      .set('Authorization', `Bearer ${otherAuth}`)
      .send({ name: 'Their fern' });
    expect(plant.status).toBe(201);
    const task = await request(app)
      .post('/tasks')
      .set('Authorization', `Bearer ${otherAuth}`)
      .send({ plantId: plant.body.id, type: 'water', frequency: 7 });
    expect(task.status).toBe(201);

    const res = await request(app).post(`/caretaker/${seat.token}/tasks/${task.body.id}/complete`);
    expect(res.status).toBe(404);
  });

  it('records a note under the caretaker’s name', async () => {
    entitleSeedHousehold();
    const auth = await loginAsSeed();
    const seat = await createSeat(auth);

    const res = await request(app)
      .post(`/caretaker/${seat.token}/notes`)
      .send({ text: 'The fern by the window looks unhappy.' });
    expect(res.status).toBe(200);
    expect(res.body.visitRecorded).toBe(true);

    const event = [...db.activity.values()].find((e) => e.type === 'caretaker.note');
    expect(event?.actorName).toBe('Dana');
    expect((event?.payload as { text: string }).text).toBe('The fern by the window looks unhappy.');
  });

  it('adds a photo to a plant in its own household and nowhere else', async () => {
    entitleSeedHousehold();
    const auth = await loginAsSeed();
    const seat = await createSeat(auth);

    const grant = await request(app)
      .post(`/caretaker/${seat.token}/plants/${seedPlantId}/photo`)
      .send({ contentType: 'image/jpeg' });
    expect(grant.status).toBe(200);

    const uploadPath = new URL(grant.body.uploadUrl).pathname;
    const put = await request(app)
      .put(uploadPath)
      .set('Content-Type', 'image/jpeg')
      .send(Buffer.from('fake-jpeg-bytes'));
    expect(put.status).toBeLessThan(300);

    const confirm = await request(app)
      .post(`/caretaker/${seat.token}/plants/${seedPlantId}/photo/confirm`)
      .send({ imageUrl: grant.body.imageUrl });
    expect(confirm.status).toBe(200);
    expect(confirm.body.photo.uploadedBy).toBe(`caretaker:${seat.id}`);

    const otherAuth = await createUserWithHousehold('neighbour2@example.com', 'Next door');
    const plant = await request(app)
      .post('/plants')
      .set('Authorization', `Bearer ${otherAuth}`)
      .send({ name: 'Their fern' });
    const crossed = await request(app)
      .post(`/caretaker/${seat.token}/plants/${plant.body.id}/photo`)
      .send({});
    expect(crossed.status).toBe(404);
  });

  it('exposes no route beyond the three actions plus the two photo steps', async () => {
    entitleSeedHousehold();
    const auth = await loginAsSeed();
    const seat = await createSeat(auth);

    // Everything a MEMBER can do that a caretaker must not. None of these
    // exist under the token, so each is a 404 from the router.
    for (const path of [
      `/caretaker/${seat.token}/plants`,
      `/caretaker/${seat.token}/members`,
      `/caretaker/${seat.token}/activity`,
      `/caretaker/${seat.token}/caretakers`,
      `/caretaker/${seat.token}/billing`,
      `/caretaker/${seat.token}/settings`,
    ]) {
      const res = await request(app).get(path);
      expect(res.status).toBe(404);
    }

    // And the token is not a session: it opens nothing on the authed API.
    const authed = await request(app)
      .get(`/households/${seedHouseholdId}/caretakers`)
      .set('Authorization', `Bearer ${seat.token}`);
    expect(authed.status).toBe(401);
  });
});

describe('proof-of-visit report', () => {
  it('reports the visit with its arrival time taken from the first action', async () => {
    entitleSeedHousehold();
    const auth = await loginAsSeed();
    const seat = await createSeat(auth);

    const before = Date.now();
    await request(app).post(`/caretaker/${seat.token}/tasks/${seedTaskId}/complete`);
    await request(app).post(`/caretaker/${seat.token}/notes`).send({ text: 'All watered.' });

    const report = await request(app)
      .get(`/households/${seedHouseholdId}/caretaker-report`)
      .set('Authorization', `Bearer ${auth}`);
    expect(report.status).toBe(200);
    expect(report.body.totals).toMatchObject({
      visits: 1,
      tasksCompleted: 1,
      notes: 1,
      caretakers: 1,
    });

    // Both actions folded into ONE visit, and the arrival time is the first
    // action's timestamp — observed, not typed by the caretaker.
    const [visit] = report.body.visits;
    expect(visit.caretakerName).toBe('Dana');
    expect(Date.parse(visit.startedAt)).toBeGreaterThanOrEqual(before);
    expect(visit.tasksCompleted).toHaveLength(1);
    expect(visit.notes).toHaveLength(1);
    expect(visit.detailTruncated).toBe(false);

    expect(report.body.byCaretaker).toHaveLength(1);
    expect(report.body.byCaretaker[0].caretakerName).toBe('Dana');
  });

  it('keeps visits after the seat is revoked — the work still happened', async () => {
    entitleSeedHousehold();
    const auth = await loginAsSeed();
    const seat = await createSeat(auth);
    await request(app).post(`/caretaker/${seat.token}/notes`).send({ text: 'Watered.' });

    await request(app)
      .delete(`/households/${seedHouseholdId}/caretakers/${seat.id}`)
      .set('Authorization', `Bearer ${auth}`);

    const report = await request(app)
      .get(`/households/${seedHouseholdId}/caretaker-report`)
      .set('Authorization', `Bearer ${auth}`);
    expect(report.status).toBe(200);
    expect(report.body.totals.visits).toBe(1);
  });

  it('rejects an inverted range rather than reporting an empty one', async () => {
    entitleSeedHousehold();
    const auth = await loginAsSeed();
    const res = await request(app)
      .get(`/households/${seedHouseholdId}/caretaker-report?from=2026-09-30&to=2026-09-01`)
      .set('Authorization', `Bearer ${auth}`);
    expect(res.status).toBe(400);
  });

  it('is readable by a non-admin member', async () => {
    entitleSeedHousehold();
    const adminAuth = await loginAsSeed();
    const invite = await request(app)
      .post(`/households/${seedHouseholdId}/invites`)
      .set('Authorization', `Bearer ${adminAuth}`)
      .send({});
    expect(invite.status).toBe(201);

    provisionLocalUserFixture({
      email: 'member@example.com',
      password: 'password-123',
      name: 'Member',
    });
    const login = await request(app)
      .post('/auth/login')
      .send({ email: 'member@example.com', password: 'password-123' });
    const memberAuth = login.body.accessToken as string;
    const joined = await request(app)
      .post(`/households/join/${invite.body.code}`)
      .set('Authorization', `Bearer ${memberAuth}`)
      .send({});
    expect(joined.status).toBe(200);

    // Creating a seat stays admin-only; reading the record does not.
    const create = await request(app)
      .post(`/households/${seedHouseholdId}/caretakers`)
      .set('Authorization', `Bearer ${memberAuth}`)
      .send({ name: 'Dana', expiresAt: inFuture(7) });
    expect(create.status).toBe(403);

    const report = await request(app)
      .get(`/households/${seedHouseholdId}/caretaker-report`)
      .set('Authorization', `Bearer ${memberAuth}`);
    expect(report.status).toBe(200);
  });
});
