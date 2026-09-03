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

  it('rejects a window past the 90-day ceiling (400, before any plan check)', async () => {
    const token = await loginAsSeed();
    db.households.get(seedHouseholdId)!.planId = 'garden';
    const res = await request(app)
      .post(`/households/${seedHouseholdId}/sitter-links`)
      .set('Authorization', `Bearer ${token}`)
      .send({ expiresAt: inFuture(120) });
    expect(res.status).toBe(400);
  });

  it('Seedling: refuses (402) an 8-day window and a second live link; Garden allows 30 days', async () => {
    const token = await loginAsSeed();
    db.households.get(seedHouseholdId)!.planId = 'seedling';

    const tooLong = await request(app)
      .post(`/households/${seedHouseholdId}/sitter-links`)
      .set('Authorization', `Bearer ${token}`)
      .send({ expiresAt: inFuture(8) });
    expect(tooLong.status).toBe(402);
    expect(tooLong.body.message).toMatch(/up to 7 days/);

    const first = await request(app)
      .post(`/households/${seedHouseholdId}/sitter-links`)
      .set('Authorization', `Bearer ${token}`)
      .send({ expiresAt: inFuture(7) });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/households/${seedHouseholdId}/sitter-links`)
      .set('Authorization', `Bearer ${token}`)
      .send({ expiresAt: inFuture(3) });
    expect(second.status).toBe(402);
    expect(second.body.message).toMatch(/1 live sitter link at a time/);

    // Revoking the live one frees the slot.
    await request(app)
      .delete(`/households/${seedHouseholdId}/sitter-links/${first.body.id}`)
      .set('Authorization', `Bearer ${token}`);
    const again = await request(app)
      .post(`/households/${seedHouseholdId}/sitter-links`)
      .set('Authorization', `Bearer ${token}`)
      .send({ expiresAt: inFuture(3) });
    expect(again.status).toBe(201);

    db.households.get(seedHouseholdId)!.planId = 'garden';
    const month = await request(app)
      .post(`/households/${seedHouseholdId}/sitter-links`)
      .set('Authorization', `Bearer ${token}`)
      .send({ expiresAt: inFuture(30) });
    expect(month.status).toBe(201);
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
  async function createLink(overrides: Record<string, unknown> = {}): Promise<string> {
    const token = await loginAsSeed();
    const res = await request(app)
      .post(`/households/${seedHouseholdId}/sitter-links`)
      .set('Authorization', `Bearer ${token}`)
      .send({ expiresAt: inFuture(7), label: 'Our plants', ...overrides });
    expect(res.status).toBe(201);
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

  it('shows the sitter every task due inside the link window, not only seven days ahead', async () => {
    // A three-week trip: the sitter must see week-three work too. (The
    // lookahead used to be hardcoded to 7 days regardless of the window.)
    db.households.get(seedHouseholdId)!.planId = 'garden';
    db.tasks.get(seedTaskId)!.nextDue = inFuture(18);
    const sitterToken = await createLink({ expiresAt: inFuture(21) });
    const res = await request(app).get(`/sitter/${sitterToken}`);
    expect(res.status).toBe(200);
    expect(res.body.tasks.map((t: { taskId: string }) => t.taskId)).toContain(seedTaskId);
    expect(res.body.tasks[0].overdue).toBe(false);
  });

  it('keeps a short link short: work due after the window is not shown', async () => {
    db.tasks.get(seedTaskId)!.nextDue = inFuture(6);
    const sitterToken = await createLink({ expiresAt: inFuture(3) });
    const res = await request(app).get(`/sitter/${sitterToken}`);
    expect(res.status).toBe(200);
    expect(res.body.tasks.map((t: { taskId: string }) => t.taskId)).not.toContain(seedTaskId);
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
    const expectedNextDue = db.tasks.get(seedTaskId)!.nextDue;
    const completionsBefore = db.completions.size;
    const res = await request(app)
      .post(`/sitter/${sitterToken}/tasks/${seedTaskId}/complete`)
      .send({ expectedNextDue });
    expect(res.status).toBe(200);
    expect(res.body.taskId).toBe(seedTaskId);
    expect(res.body.overdue).toBe(false);

    // A completion + activity row landed, attributed to the sitter (no member).
    const completion = [...db.completions.values()].find((c) => c.taskId === seedTaskId);
    expect(completion?.completedByName).toBe('a plant sitter');
    expect(completion?.completedBy).toMatch(/^sitter:/);

    const retry = await request(app)
      .post(`/sitter/${sitterToken}/tasks/${seedTaskId}/complete`)
      .send({ expectedNextDue });
    expect(retry.status).toBe(200);
    expect(retry.body.dueDate).toBe(db.tasks.get(seedTaskId)!.nextDue);
    expect(db.completions.size).toBe(completionsBefore + 1);
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

/** A confirmed non-admin member of the seed household; returns their token. */
async function loginAsSeedMember(email = 'member@example.com', name = 'Member Person') {
  const fixture = provisionLocalUserFixture({ email, password: 'password-123', name });
  fixture.householdId = seedHouseholdId;
  fixture.householdRole = 'member';
  fixture.memberships.push({
    householdId: seedHouseholdId,
    role: 'member',
    joinedAt: new Date().toISOString(),
  });
  const login = await request(app).post('/auth/login').send({ email, password: 'password-123' });
  expect(login.status).toBe(200);
  return login.body.accessToken as string;
}

describe('sitter links are open to every member; revocation is creator-or-admin', () => {
  it('a plain member can create and list links, and the feed names them', async () => {
    const member = await loginAsSeedMember();
    const created = await request(app)
      .post(`/households/${seedHouseholdId}/sitter-links`)
      .set('Authorization', `Bearer ${member}`)
      .send({ expiresAt: inFuture(5), label: 'While I am away' });
    expect(created.status).toBe(201);
    expect(created.body.token).toMatch(/^[0-9a-f]{64}$/);

    const listed = await request(app)
      .get(`/households/${seedHouseholdId}/sitter-links`)
      .set('Authorization', `Bearer ${member}`);
    expect(listed.status).toBe(200);
    expect(listed.body.map((l: { id: string }) => l.id)).toContain(created.body.id);

    const feed = await request(app)
      .get(`/households/${seedHouseholdId}/activity`)
      .set('Authorization', `Bearer ${member}`);
    expect(feed.status).toBe(200);
    const event = feed.body.find(
      (e: { type: string; payload: { linkId: string } }) =>
        e.type === 'sitter_link.created' && e.payload.linkId === created.body.id
    );
    expect(event).toBeDefined();
    expect(event.actorName).toBe('Member Person');
    expect(JSON.stringify(event)).not.toContain(created.body.token);
  });

  it('a member can revoke their own link but not another member’s; an admin can revoke any', async () => {
    // Two live links at once needs a paid plan (the Seedling cap is 1).
    db.households.get(seedHouseholdId)!.planId = 'garden';
    const admin = await loginAsSeed();
    const member = await loginAsSeedMember();

    const mine = await request(app)
      .post(`/households/${seedHouseholdId}/sitter-links`)
      .set('Authorization', `Bearer ${member}`)
      .send({ expiresAt: inFuture(5) });
    const theirs = await request(app)
      .post(`/households/${seedHouseholdId}/sitter-links`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ expiresAt: inFuture(5) });
    expect(mine.status).toBe(201);
    expect(theirs.status).toBe(201);

    const forbidden = await request(app)
      .delete(`/households/${seedHouseholdId}/sitter-links/${theirs.body.id}`)
      .set('Authorization', `Bearer ${member}`);
    expect(forbidden.status).toBe(403);
    // The other member's link still works after the refused attempt.
    expect((await request(app).get(`/sitter/${theirs.body.token}`)).status).toBe(200);

    const own = await request(app)
      .delete(`/households/${seedHouseholdId}/sitter-links/${mine.body.id}`)
      .set('Authorization', `Bearer ${member}`);
    expect(own.status).toBe(204);
    expect((await request(app).get(`/sitter/${mine.body.token}`)).status).toBe(404);

    const byAdmin = await request(app)
      .delete(`/households/${seedHouseholdId}/sitter-links/${theirs.body.id}`)
      .set('Authorization', `Bearer ${admin}`);
    expect(byAdmin.status).toBe(204);
    expect((await request(app).get(`/sitter/${theirs.body.token}`)).status).toBe(404);
  });
});

describe('sitter handoff brief (public, paid half of the Away Kit)', () => {
  async function link(planId: 'seedling' | 'garden' = 'garden'): Promise<string> {
    db.households.get(seedHouseholdId)!.planId = planId;
    const token = await loginAsSeed();
    const res = await request(app)
      .post(`/households/${seedHouseholdId}/sitter-links`)
      .set('Authorization', `Bearer ${token}`)
      .send({ expiresAt: inFuture(planId === 'garden' ? 21 : 7), label: 'Our plants' });
    expect(res.status).toBe(201);
    return res.body.token as string;
  }

  it('renders the household’s own notes, place, photo and window tasks — no auth, no PII', async () => {
    const plant = db.plants.get(seedPlantId)!;
    plant.placementNote = 'east window, top shelf';
    plant.notes = 'Bottom-water this one';
    plant.species = 'Monstera deliciosa';
    db.tasks.get(seedTaskId)!.notes = 'Use the private measuring cup';
    db.households.get(seedHouseholdId)!.location = { city: 'Private Climate City', lat: 1, lon: 2 };

    const token = await link();
    const res = await request(app).get(`/sitter/${token}/brief`); // no Authorization
    expect(res.status).toBe(200);
    expect(res.body.label).toBe('Our plants');

    const entry = res.body.plants.find((p: { plantId: string }) => p.plantId === seedPlantId);
    expect(entry).toMatchObject({
      name: 'Monstera',
      spaceName: 'Living Room',
      placementNote: 'east window, top shelf',
      careNote: 'Bottom-water this one',
      careNoteSource: 'notes',
    });
    // Verdicts come from the curated table, never generated.
    expect(entry.petSafety).toMatchObject({ slug: 'monstera', cats: 'toxic', dogs: 'toxic' });
    expect(entry.tasks.map((t: { taskId: string }) => t.taskId)).toContain(seedTaskId);

    const blob = JSON.stringify(res.body);
    expect(blob).not.toContain(SEED_EMAIL);
    expect(blob).not.toContain('Test User');
    expect(blob).not.toContain(seedHouseholdId);
    expect(blob).not.toContain('Private Climate City');
    expect(blob).not.toContain('Use the private measuring cup');
  });

  it('renders a plant with no notes as having none, and no toxicity verdict it cannot source', async () => {
    const plant = db.plants.get(seedPlantId)!;
    plant.placementNote = null;
    plant.notes = null;
    plant.species = 'Nothing recognisable here';
    plant.name = 'Doris';

    const token = await link();
    const res = await request(app).get(`/sitter/${token}/brief`);
    expect(res.status).toBe(200);
    const entry = res.body.plants.find((p: { plantId: string }) => p.plantId === seedPlantId);
    expect(entry.careNote).toBeNull();
    expect(entry.careNoteSource).toBeNull();
    expect(entry.placementNote).toBeNull();
    expect(entry.petSafety).toBeNull();
  });

  it('answers the same generic 404 on a free plan as it does for a bad token', async () => {
    const token = await link('seedling');
    const onFree = await request(app).get(`/sitter/${token}/brief`);
    const onGarbage = await request(app).get(`/sitter/${'f'.repeat(64)}/brief`);
    expect(onFree.status).toBe(404);
    expect(onGarbage.status).toBe(404);
    expect(onFree.body.message).toBe(onGarbage.body.message);
    // The task list itself still works on the free tier.
    expect((await request(app).get(`/sitter/${token}`)).status).toBe(200);
  });

  it('404s the brief once the link is revoked', async () => {
    const token = await link();
    const auth = await loginAsSeed();
    const listed = await request(app)
      .get(`/households/${seedHouseholdId}/sitter-links`)
      .set('Authorization', `Bearer ${auth}`);
    await request(app)
      .delete(`/households/${seedHouseholdId}/sitter-links/${listed.body[0].id}`)
      .set('Authorization', `Bearer ${auth}`);
    expect((await request(app).get(`/sitter/${token}/brief`)).status).toBe(404);
  });
});
