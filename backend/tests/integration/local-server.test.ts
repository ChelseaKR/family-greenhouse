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
  seedUserId,
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

// Direct local fixture → login. Public signup remains closed during the hold.
async function createConfirmedUser(
  email: string,
  password = 'password-123',
  name = 'Test Person'
): Promise<string> {
  provisionLocalUserFixture({ email, password, name });
  const login = await request(app).post('/auth/login').send({ email, password });
  expect(login.status).toBe(200);
  return login.body.accessToken as string;
}

/** Direct-fixture helper: membership records are the auth source of truth. */
function seedMember(
  id: string,
  email: string,
  role: 'admin' | 'member',
  householdId = seedHouseholdId
): void {
  db.users.set(id, {
    id,
    email,
    password: 'password-123',
    name: `User ${id}`,
    confirmed: true,
    householdId,
    householdRole: role,
    memberships: [{ householdId, role, joinedAt: new Date().toISOString() }],
  } as never);
}

beforeEach(() => {
  resetDb();
});

// Silence noisy console output from the dev server during tests.
const originalLog = console.log;
beforeEach(() => {
  console.log = () => {};
});
afterEach(() => {
  console.log = originalLog;
});

describe('GET /health', () => {
  it('returns ok with component breakdown', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    // Subsystem reachability surface used by the marketing /status page.
    expect(res.body.components).toMatchObject({
      database: { status: 'ok' },
      auth: { status: 'ok' },
      mail: { status: 'ok' },
    });
    expect(typeof res.body.checkedAt).toBe('string');
  });
});

describe('auth routes', () => {
  describe('POST /auth/signup', () => {
    it('fails closed without creating a user or pending confirmation', async () => {
      const res = await request(app)
        .post('/auth/signup')
        .send({ email: 'new@example.com', password: 'password-123', name: 'New User' });
      expect(res.status).toBe(503);
      expect(res.body.message).toMatch(/registration.*paused/i);
      const created = [...db.users.values()].find((u) => u.email === 'new@example.com');
      expect(created).toBeUndefined();
      expect(db.pendingConfirmations.has('new@example.com')).toBe(false);
    });

    it('returns the hold response even for malformed acquisition attempts', async () => {
      const res = await request(app).post('/auth/signup').send({ email: 'a@b.com' });
      expect(res.status).toBe(503);
      expect(res.body.message).toMatch(/registration.*paused/i);
    });
  });

  describe('POST /auth/confirm', () => {
    it('confirms the user and returns only a message — production never returns tokens here', async () => {
      provisionLocalUserFixture({
        email: 'c@example.com',
        password: 'password-123',
        name: 'Cee',
        confirmed: false,
      });
      const res = await request(app)
        .post('/auth/confirm')
        .send({ email: 'c@example.com', code: '123456' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ message: 'Email confirmed successfully. Please login.' });
      // The user can now login.
      const login = await request(app)
        .post('/auth/login')
        .send({ email: 'c@example.com', password: 'password-123' });
      expect(login.status).toBe(200);
      expect(login.body.accessToken).toMatch(/^mock-token-/);
    });

    it('rejects invalid code', async () => {
      provisionLocalUserFixture({
        email: 'd@example.com',
        password: 'password-123',
        name: 'Dee',
        confirmed: false,
      });
      const res = await request(app)
        .post('/auth/confirm')
        .send({ email: 'd@example.com', code: '999999' });
      expect(res.status).toBe(400);
    });

    it('rejects already-confirmed user', async () => {
      const res = await request(app)
        .post('/auth/confirm')
        .send({ email: SEED_EMAIL, code: '123456' });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /auth/login', () => {
    it('returns tokens whose access token decodes back to the seed user', async () => {
      const res = await request(app)
        .post('/auth/login')
        .send({ email: SEED_EMAIL, password: SEED_PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe(seedUserId);
      // Production login returns idToken + accessToken + refreshToken +
      // expiresIn (the ID token carries household claims; the access token
      // is for Cognito-direct calls).
      expect(res.body.idToken).toMatch(/^mock-token-/);
      expect(typeof res.body.expiresIn).toBe('number');
      // Regression: tokens were previously parsed by splitting on '-',
      // which broke when the userId itself was a UUID with dashes.
      const meRes = await request(app)
        .get('/auth/me')
        .set('Authorization', `Bearer ${res.body.accessToken}`);
      expect(meRes.status).toBe(200);
      expect(meRes.body.id).toBe(seedUserId);
    });

    it('rejects bad password', async () => {
      const res = await request(app)
        .post('/auth/login')
        .send({ email: SEED_EMAIL, password: 'wrong' });
      expect(res.status).toBe(401);
    });

    it('rejects unknown email', async () => {
      const res = await request(app)
        .post('/auth/login')
        .send({ email: 'nope@x.com', password: 'pw' });
      expect(res.status).toBe(401);
    });

    it('rejects unconfirmed user', async () => {
      provisionLocalUserFixture({
        email: 'u@example.com',
        password: 'password-123',
        name: 'Uma',
        confirmed: false,
      });
      const res = await request(app)
        .post('/auth/login')
        .send({ email: 'u@example.com', password: 'password-123' });
      expect(res.status).toBe(401);
      expect(res.body.message).toBe('Please confirm your email first');
    });
  });

  describe('POST /auth/refresh', () => {
    it('mints a new access token from a valid refresh token', async () => {
      const login = await request(app)
        .post('/auth/login')
        .send({ email: SEED_EMAIL, password: SEED_PASSWORD });
      const res = await request(app)
        .post('/auth/refresh')
        .send({ refreshToken: login.body.refreshToken });
      expect(res.status).toBe(200);
      expect(res.body.accessToken).toMatch(/^mock-token-/);
      expect(res.body.idToken).toMatch(/^mock-token-/);
      // Cognito does not rotate refresh tokens — production echoes the
      // original back so the frontend never clobbers its stored value.
      expect(res.body.refreshToken).toBe(login.body.refreshToken);
    });

    it('rejects garbage refresh tokens', async () => {
      const res = await request(app).post('/auth/refresh').send({ refreshToken: 'nope' });
      expect(res.status).toBe(401);
    });

    it('requires a refresh token (Zod 400)', async () => {
      const res = await request(app).post('/auth/refresh').send({});
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Validation failed');
    });
  });

  describe('POST /auth/resend-code', () => {
    it('returns 200 even for an unknown email (no enumeration)', async () => {
      const res = await request(app)
        .post('/auth/resend-code')
        .send({ email: 'not-a-user@example.com' });
      expect(res.status).toBe(200);
    });

    it('rejects already-confirmed users with 400', async () => {
      const res = await request(app).post('/auth/resend-code').send({ email: SEED_EMAIL });
      expect(res.status).toBe(400);
    });

    it('regenerates the pending code for unconfirmed users', async () => {
      provisionLocalUserFixture({
        email: 'r@example.com',
        password: 'password-123',
        name: 'Ria',
        confirmed: false,
      });
      // Tamper with the stored code so we can verify resend overwrites it.
      db.pendingConfirmations.set('r@example.com', 'OLD');
      const res = await request(app).post('/auth/resend-code').send({ email: 'r@example.com' });
      expect(res.status).toBe(200);
      expect(db.pendingConfirmations.get('r@example.com')).toBe('123456');
    });
  });

  describe('GET /auth/me', () => {
    it('rejects requests with no Authorization header', async () => {
      const res = await request(app).get('/auth/me');
      expect(res.status).toBe(401);
    });

    it('rejects malformed bearer tokens', async () => {
      const res = await request(app).get('/auth/me').set('Authorization', 'Bearer garbage');
      expect(res.status).toBe(401);
    });
  });
});

describe('households routes', () => {
  it('creates a household and promotes the creator to admin', async () => {
    const token = await createConfirmedUser('h@example.com');

    const res = await request(app)
      .post('/households')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'New Home' });
    expect(res.status).toBe(201);
    // Production returns the household record itself (no `role` field).
    expect(res.body.id).toBeTruthy();
    expect(res.body.name).toBe('New Home');
    expect(res.body.createdBy).toBeTruthy();
    // …but the creator's membership record is admin.
    const creator = [...db.users.values()].find((u) => u.email === 'h@example.com')!;
    expect(creator.memberships).toContainEqual(
      expect.objectContaining({ householdId: res.body.id, role: 'admin' })
    );
  });

  it('returns the seed household with members', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .get(`/households/${seedHouseholdId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Test Household');
    expect(res.body.members).toHaveLength(1);
    expect(res.body.members[0].email).toBe(SEED_EMAIL);
  });

  it('POST /households/:id/invites returns the contract the frontend expects', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .post(`/households/${seedHouseholdId}/invites`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(201);
    // Regression: previously returned `{ inviteCode }`, but Lambda + frontend
    // both expect `{ code, expiresAt, url }`. The Generate-invite-link button
    // silently no-op'd because `data.url` was undefined.
    expect(typeof res.body.code).toBe('string');
    expect(res.body.code.length).toBeGreaterThan(8);
    expect(typeof res.body.expiresAt).toBe('string');
    expect(typeof res.body.url).toBe('string');
    expect(res.body.url).toContain(res.body.code);
  });

  it('403s a household the caller is not scoped to (production checks access before existence)', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .get('/households/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${token}`);
    // Production compares the path id against the caller's resolved
    // household BEFORE looking it up — an unknown id is indistinguishable
    // from someone else's household: 403, not 404.
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Access denied');
  });
});

describe('plant-space routes', () => {
  it('defaults new outdoor spaces to rain exposed', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .post('/spaces')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Back garden', environment: 'outside' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      householdId: seedHouseholdId,
      environment: 'outside',
      rainExposure: 'exposed',
    });
  });

  it('stores covered outdoor placement and resets indoor spaces to sheltered', async () => {
    const token = await loginAsSeed();
    const create = await request(app)
      .post('/spaces')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Covered porch', environment: 'outside', rainExposure: 'sheltered' });
    expect(create.status).toBe(201);
    expect(create.body.rainExposure).toBe('sheltered');

    const update = await request(app)
      .put(`/spaces/${create.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ environment: 'inside', rainExposure: 'exposed' });
    expect(update.status).toBe(200);
    expect(update.body).toMatchObject({ environment: 'inside', rainExposure: 'sheltered' });
  });

  it('stores, updates, and clears optional placement-fit details', async () => {
    const token = await loginAsSeed();
    const create = await request(app).post('/spaces').set('Authorization', `Bearer ${token}`).send({
      name: 'Pet-friendly sunroom',
      environment: 'inside',
      lightLevel: 'bright',
      petAccess: true,
    });
    expect(create.status).toBe(201);
    expect(create.body).toMatchObject({ lightLevel: 'bright', petAccess: true });

    const update = await request(app)
      .put(`/spaces/${create.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ lightLevel: null, petAccess: false });
    expect(update.status).toBe(200);
    expect(update.body).toMatchObject({ lightLevel: null, petAccess: false });

    const invalid = await request(app)
      .put(`/spaces/${create.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ lightLevel: 'sunny-ish' });
    expect(invalid.status).toBe(400);
  });
});

describe('plants routes', () => {
  it('lists plants scoped to the user household', async () => {
    const token = await loginAsSeed();
    const res = await request(app).get('/plants').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe('Monstera');
  });

  it('GET /plants/:id returns upcomingTasks (frontend contract)', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .get(`/plants/${seedPlantId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    // Regression: previously returned `tasks` instead of `upcomingTasks`,
    // which made the PlantDetailPage crash.
    expect(Array.isArray(res.body.upcomingTasks)).toBe(true);
    expect(Array.isArray(res.body.recentCompletions)).toBe(true);
    expect(res.body.upcomingTasks.length).toBe(1);
  });

  it('creates a plant and ties it to the caller household', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .post('/plants')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Pothos', species: 'Epipremnum aureum' });
    expect(res.status).toBe(201);
    expect(res.body.householdId).toBe(seedHouseholdId);
    expect(res.body.id).toBeTruthy();
  });

  it('updates a plant', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .put(`/plants/${seedPlantId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ location: 'Office' });
    expect(res.status).toBe(200);
    expect(res.body.location).toBe('Office');
  });

  it('stores and validates seasonal homes and protects referenced spaces', async () => {
    const token = await loginAsSeed();
    const summer = await request(app)
      .post('/spaces')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Summer patio', environment: 'outside' });
    const winter = await request(app)
      .post('/spaces')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Winter window', environment: 'inside' });

    const created = await request(app)
      .post('/plants')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Seasonal citrus',
        summerSpaceId: summer.body.id,
        winterSpaceId: winter.body.id,
      });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      summerSpaceId: summer.body.id,
      winterSpaceId: winter.body.id,
    });

    const protectedDelete = await request(app)
      .delete(`/spaces/${summer.body.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(protectedDelete.status).toBe(409);

    const updated = await request(app)
      .put(`/plants/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ summerSpaceId: null });
    expect(updated.status).toBe(200);
    expect(updated.body.summerSpaceId).toBeNull();

    const invalid = await request(app)
      .put(`/plants/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ winterSpaceId: '00000000-0000-0000-0000-000000000000' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.message).toMatch(/Seasonal home not found/);
  });

  it('deletes a plant and cascades to its tasks', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .delete(`/plants/${seedPlantId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(204);
    expect(db.plants.has(seedPlantId)).toBe(false);
    for (const task of db.tasks.values()) {
      expect(task.plantId).not.toBe(seedPlantId);
    }
  });

  it('returns 404 for unknown plant', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .get('/plants/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('rejects unauthenticated plant access', async () => {
    const res = await request(app).get('/plants');
    expect(res.status).toBe(401);
  });
});

describe('tasks routes', () => {
  it('lists tasks with plantName joined', async () => {
    const token = await loginAsSeed();
    const res = await request(app).get('/tasks').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body[0].plantName).toBe('Monstera');
  });

  it('lists upcoming tasks within 7 days', async () => {
    const token = await loginAsSeed();
    const res = await request(app).get('/tasks/upcoming').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  it('creates a task due immediately by default (production semantics)', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .post('/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ plantId: seedPlantId, type: 'fertilize', frequency: 14 });
    expect(res.status).toBe(201);
    // Production taskService.createTask: nextDue defaults to NOW (the task
    // is due immediately) unless the client passes an explicit nextDue. The
    // mock previously scheduled `frequency` days out — that was drift.
    const due = new Date(res.body.nextDue).getTime();
    expect(Math.abs(due - Date.now())).toBeLessThan(60 * 1000);
  });

  it('honors an explicit nextDue on task creation', async () => {
    const token = await loginAsSeed();
    const nextDue = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    const res = await request(app)
      .post('/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ plantId: seedPlantId, type: 'fertilize', frequency: 14, nextDue });
    expect(res.status).toBe(201);
    expect(res.body.nextDue).toBe(nextDue);
  });

  it('400s task creation with a missing frequency (Zod, no RangeError crash)', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .post('/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ plantId: seedPlantId, type: 'water' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Validation failed');
    expect(res.body.details).toHaveProperty('frequency');
  });

  it('400s GET /tasks?dueWithin=<non-numeric>', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .get('/tasks?dueWithin=soon')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('dueWithin must be a non-negative integer');
  });

  it('GET /tasks/:id returns the task, household-scoped', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .get(`/tasks/${seedTaskId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(seedTaskId);
    expect(res.body.plantName).toBe('Monstera');
  });

  it('filters tasks of died/gave_away plants out of task lists', async () => {
    const token = await loginAsSeed();
    const mark = await request(app)
      .put(`/plants/${seedPlantId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'died' });
    expect(mark.status).toBe(200);
    const list = await request(app).get('/tasks').set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body).toEqual([]);
    const upcoming = await request(app)
      .get('/tasks/upcoming')
      .set('Authorization', `Bearer ${token}`);
    expect(upcoming.body).toEqual([]);
  });

  it('refuses to create a task on a plant from a different household', async () => {
    const otherToken = await createConfirmedUser('x@example.com');
    await request(app)
      .post('/households')
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ name: 'Other Home' });

    const res = await request(app)
      .post('/tasks')
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ plantId: seedPlantId, type: 'water', frequency: 7 });
    expect(res.status).toBe(404);
  });

  it('completes a task and rolls nextDue forward by frequency', async () => {
    const token = await loginAsSeed();
    const before = db.tasks.get(seedTaskId)!;
    const res = await request(app)
      .post(`/tasks/${seedTaskId}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.lastCompleted).toBeTruthy();
    const newDue = new Date(res.body.nextDue).getTime();
    const expected = Date.now() + before.frequency * 24 * 60 * 60 * 1000;
    expect(Math.abs(newDue - expected)).toBeLessThan(60 * 1000);
  });

  it('updates a task', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .put(`/tasks/${seedTaskId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ frequency: 30, notes: 'monthly' });
    expect(res.status).toBe(200);
    expect(res.body.frequency).toBe(30);
    expect(res.body.notes).toBe('monthly');
  });

  it('deletes a task', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .delete(`/tasks/${seedTaskId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(204);
    expect(db.tasks.has(seedTaskId)).toBe(false);
  });
});

describe('PUT /households/:id/members/:userId/role', () => {
  it('promotes a member to admin via the role endpoint', async () => {
    // Seed a second user on the same household.
    seedMember('user-2', 'two@example.com', 'member');
    const token = await loginAsSeed();
    const res = await request(app)
      .put(`/households/${seedHouseholdId}/members/user-2/role`)
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'admin' });
    expect(res.status).toBe(200);
    // Production returns the updated member row.
    expect(res.body).toMatchObject({
      householdId: seedHouseholdId,
      userId: 'user-2',
      role: 'admin',
    });
    // The membership record (auth source of truth) is updated…
    expect(db.users.get('user-2')?.memberships[0].role).toBe('admin');
    // …and so is the claim default, since this is user-2's default household.
    expect(db.users.get('user-2')?.householdRole).toBe('admin');
  });

  it('refuses self-demotion', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .put(`/households/${seedHouseholdId}/members/${seedUserId}/role`)
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'member' });
    expect(res.status).toBe(400);
  });

  it('rejects non-admin callers with 403', async () => {
    seedMember('user-3', 'three@example.com', 'member');
    const login = await request(app)
      .post('/auth/login')
      .send({ email: 'three@example.com', password: 'password-123' });
    const res = await request(app)
      .put(`/households/${seedHouseholdId}/members/${seedUserId}/role`)
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .send({ role: 'member' });
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Admin access required');
  });
});

describe('DELETE /households/:householdId/members/:userId', () => {
  it('lets an admin remove a member and clears their default-household claim', async () => {
    seedMember('member-r', 'removeme@example.com', 'member');
    const token = await loginAsSeed();
    const res = await request(app)
      .delete(`/households/${seedHouseholdId}/members/member-r`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(204);
    const removed = db.users.get('member-r')!;
    expect(removed.memberships).toEqual([]);
    // Claim semantics: this was their default household → cleared.
    expect(removed.householdId).toBeNull();
    expect(removed.householdRole).toBeNull();
    // …and the removed member is locked out on their next request.
    const login = await request(app)
      .post('/auth/login')
      .send({ email: 'removeme@example.com', password: 'password-123' });
    const plants = await request(app)
      .get('/plants')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .set('X-Household-Id', seedHouseholdId);
    expect(plants.status).toBe(403);
  });

  it('refuses self-removal', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .delete(`/households/${seedHouseholdId}/members/${seedUserId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Cannot remove yourself from household');
  });

  it('404s an unknown member', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .delete(`/households/${seedHouseholdId}/members/no-such-user`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

describe('POST /tasks/:id/snooze', () => {
  it('pushes nextDue forward by N days', async () => {
    const token = await loginAsSeed();
    const before = new Date(db.tasks.get(seedTaskId)!.nextDue).getTime();
    const res = await request(app)
      .post(`/tasks/${seedTaskId}/snooze`)
      .set('Authorization', `Bearer ${token}`)
      .send({ days: 3 });
    expect(res.status).toBe(200);
    const after = new Date(res.body.nextDue).getTime();
    expect(after - before).toBeGreaterThan(2.9 * 24 * 60 * 60 * 1000);
  });

  it('bases the snooze on now for an overdue task (max(now, nextDue))', async () => {
    const token = await loginAsSeed();
    // Make the seed task 10 days overdue.
    db.tasks.get(seedTaskId)!.nextDue = new Date(
      Date.now() - 10 * 24 * 60 * 60 * 1000
    ).toISOString();
    const res = await request(app)
      .post(`/tasks/${seedTaskId}/snooze`)
      .set('Authorization', `Bearer ${token}`)
      .send({ days: 3 });
    expect(res.status).toBe(200);
    // Production snoozes from max(now, nextDue): 3 days from NOW, not from
    // the stale overdue date (which would leave it still overdue).
    const after = new Date(res.body.nextDue).getTime();
    const expected = Date.now() + 3 * 24 * 60 * 60 * 1000;
    expect(Math.abs(after - expected)).toBeLessThan(60 * 1000);
  });

  it('rejects bogus days (Zod 400)', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .post(`/tasks/${seedTaskId}/snooze`)
      .set('Authorization', `Bearer ${token}`)
      .send({ days: 0 });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Validation failed');
  });
});

describe('GET /households/:id/activity', () => {
  it('returns recent completions for the caller household, newest first', async () => {
    const token = await loginAsSeed();
    // Generate a couple of completions.
    await request(app)
      .post(`/tasks/${seedTaskId}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ notes: 'first' });
    await request(app)
      .post(`/tasks/${seedTaskId}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ notes: 'second' });

    const res = await request(app)
      .get(`/households/${seedHouseholdId}/activity`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    // The activity feed is now a unified envelope with `type` + `occurredAt`.
    // Filter to task.completed events for this assertion.
    const completions = res.body.filter((e: { type: string }) => e.type === 'task.completed');
    expect(completions.length).toBe(2);
    expect(
      new Date(completions[0].occurredAt).getTime() >= new Date(completions[1].occurredAt).getTime()
    ).toBe(true);
  });

  it('blocks cross-household access', async () => {
    const otherToken = await createConfirmedUser('q@example.com');
    await request(app)
      .post('/households')
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ name: 'Other' });
    const res = await request(app)
      .get(`/households/${seedHouseholdId}/activity`)
      .set('Authorization', `Bearer ${otherToken}`);
    expect(res.status).toBe(403);
  });
});

describe('DELETE /me', () => {
  it('refuses when caller is sole admin of a multi-member household', async () => {
    db.users.set('member-x', {
      id: 'member-x',
      email: 'x@example.com',
      password: 'pw',
      name: 'X',
      confirmed: true,
      householdId: seedHouseholdId,
      householdRole: 'member',
      memberships: [{ householdId: seedHouseholdId, role: 'member' }],
    });
    const token = await loginAsSeed();
    const res = await request(app).delete('/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it('deletes the user and wipes their solo household', async () => {
    const token = await loginAsSeed();
    const res = await request(app).delete('/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(204);
    expect(db.users.has(seedUserId)).toBe(false);
    expect(db.households.has(seedHouseholdId)).toBe(false);
    for (const p of db.plants.values()) {
      expect(p.householdId).not.toBe(seedHouseholdId);
    }
  });
});

describe('invite + join flow', () => {
  function seedPaidPlan(planId: 'garden' | 'greenhouse' = 'garden') {
    db.households.get(seedHouseholdId)!.planId = planId;
  }

  it('POST /households/join/:inviteCode joins via a valid invite and returns the household', async () => {
    const adminToken = await loginAsSeed();
    // Seedling now welcomes the whole household (up to 6), so a join into a
    // one-member household succeeds on the free plan — no upgrade required.
    const invite = await request(app)
      .post(`/households/${seedHouseholdId}/invites`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(invite.status).toBe(201);

    const joinerToken = await createConfirmedUser('joiner@example.com');
    const join = await request(app)
      .post(`/households/join/${invite.body.code}`)
      .set('Authorization', `Bearer ${joinerToken}`);
    expect(join.status).toBe(200);
    // Production returns the household record.
    expect(join.body.id).toBe(seedHouseholdId);
    expect(join.body.name).toBe('Test Household');
    const joiner = [...db.users.values()].find((u) => u.email === 'joiner@example.com')!;
    expect(joiner.memberships).toContainEqual(
      expect.objectContaining({ householdId: seedHouseholdId, role: 'member' })
    );
  });

  it('400s an unknown or expired invite code', async () => {
    const token = await createConfirmedUser('lost@example.com');
    const unknown = await request(app)
      .post('/households/join/deadbeefdeadbeefdeadbeefdeadbeef')
      .set('Authorization', `Bearer ${token}`);
    expect(unknown.status).toBe(400);
    expect(unknown.body.message).toBe('Invalid or expired invite');

    // Expired invite: backdate expiresAt.
    db.invites.set('expiredcode000000000000000000000', {
      code: 'expiredcode000000000000000000000',
      householdId: seedHouseholdId,
      createdBy: seedUserId,
      createdAt: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString(),
      expiresAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
    });
    const expired = await request(app)
      .post('/households/join/expiredcode000000000000000000000')
      .set('Authorization', `Bearer ${token}`);
    expect(expired.status).toBe(400);
    expect(expired.body.message).toBe('Invalid or expired invite');
  });

  it('402s a join that would exceed the plan member cap', async () => {
    // Seed household stays on seedling (maxMembers: 6). It starts with the
    // seed admin; fill it to the cap so the next join trips the limit.
    const adminToken = await loginAsSeed();
    const invite = await request(app)
      .post(`/households/${seedHouseholdId}/invites`)
      .set('Authorization', `Bearer ${adminToken}`);
    for (let i = 0; i < 5; i++) {
      seedMember(`cap-fill-${i}`, `cap-fill-${i}@example.com`, 'member');
    }
    db.households.get(seedHouseholdId)!.planId = 'seedling';
    const joinerToken = await createConfirmedUser('capped@example.com');
    const join = await request(app)
      .post(`/households/join/${invite.body.code}`)
      .set('Authorization', `Bearer ${joinerToken}`);
    expect(join.status).toBe(402);
    expect(join.body.message).toMatch(/limited to 6 members/);
  });

  it('400s a double-join into the same household', async () => {
    const adminToken = await loginAsSeed();
    seedPaidPlan();
    const invite = await request(app)
      .post(`/households/${seedHouseholdId}/invites`)
      .set('Authorization', `Bearer ${adminToken}`);
    const joinerToken = await createConfirmedUser('twice@example.com');
    await request(app)
      .post(`/households/join/${invite.body.code}`)
      .set('Authorization', `Bearer ${joinerToken}`);
    const again = await request(app)
      .post(`/households/join/${invite.body.code}`)
      .set('Authorization', `Bearer ${joinerToken}`);
    expect(again.status).toBe(400);
    expect(again.body.message).toBe('You are already a member of this household');
  });

  it('GET /households/invites/:code validates publicly (no auth)', async () => {
    const adminToken = await loginAsSeed();
    const invite = await request(app)
      .post(`/households/${seedHouseholdId}/invites`)
      .set('Authorization', `Bearer ${adminToken}`);
    const valid = await request(app).get(`/households/invites/${invite.body.code}`);
    expect(valid.status).toBe(200);
    expect(valid.body).toEqual({
      valid: true,
      household: { id: seedHouseholdId, name: 'Test Household' },
    });
    const bogus = await request(app).get('/households/invites/nope');
    expect(bogus.status).toBe(200);
    expect(bogus.body).toEqual({ valid: false });
  });

  it('non-admin members cannot create invites', async () => {
    seedMember('member-i', 'mi@example.com', 'member');
    const login = await request(app)
      .post('/auth/login')
      .send({ email: 'mi@example.com', password: 'password-123' });
    const res = await request(app)
      .post(`/households/${seedHouseholdId}/invites`)
      .set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Admin access required');
  });
});

describe('POST /plants/:id/image', () => {
  it('defaults to jpeg and matches the key extension to the contentType', async () => {
    const token = await loginAsSeed();
    const dflt = await request(app)
      .post(`/plants/${seedPlantId}/image`)
      .set('Authorization', `Bearer ${token}`);
    expect(dflt.status).toBe(200);
    expect(dflt.body.imageUrl).toMatch(/\.jpg$/);
    expect(dflt.body.imageUrl).toContain(`/plants/${seedHouseholdId}/${seedPlantId}/`);

    const webp = await request(app)
      .post(`/plants/${seedPlantId}/image`)
      .set('Authorization', `Bearer ${token}`)
      .send({ contentType: 'image/webp' });
    expect(webp.status).toBe(200);
    expect(webp.body.imageUrl).toMatch(/\.webp$/);
  });

  it('400s an unsupported contentType', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .post(`/plants/${seedPlantId}/image`)
      .set('Authorization', `Bearer ${token}`)
      .send({ contentType: 'image/gif' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Validation failed');
  });
});

describe('POST /plants/:id/image/confirm', () => {
  it('accepts the imageUrl returned by the upload-url endpoint', async () => {
    const token = await loginAsSeed();
    const sign = await request(app)
      .post(`/plants/${seedPlantId}/image`)
      .set('Authorization', `Bearer ${token}`);
    expect(sign.status).toBe(200);
    const confirm = await request(app)
      .post(`/plants/${seedPlantId}/image/confirm`)
      .set('Authorization', `Bearer ${token}`)
      .send({ imageUrl: sign.body.imageUrl });
    expect(confirm.status).toBe(200);
    expect(db.plants.get(seedPlantId)?.imageUrl).toBe(sign.body.imageUrl);
  });

  it("rejects an imageUrl that doesn't reference this plant", async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .post(`/plants/${seedPlantId}/image/confirm`)
      .set('Authorization', `Bearer ${token}`)
      .send({ imageUrl: 'http://elsewhere.example/' });
    expect(res.status).toBe(400);
  });
});

describe('notification preferences', () => {
  const PHONE = '+15551234567';

  /** Full verification round-trip using the mock's dev-only `devCode` echo. */
  async function verifyPhone(token: string, phone = PHONE): Promise<void> {
    const start = await request(app)
      .post('/notifications/phone/start-verification')
      .set('Authorization', `Bearer ${token}`)
      .send({ phone });
    expect(start.status).toBe(200);
    expect(start.body.sent).toBe(true);
    const confirm = await request(app)
      .post('/notifications/phone/confirm-verification')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: start.body.devCode });
    expect(confirm.status).toBe(200);
    expect(confirm.body.phoneVerified).toBe(true);
    expect(confirm.body.phone).toBe(phone);
  }

  it('GET /notifications/prefs returns defaults for a fresh user', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .get('/notifications/prefs')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      browser: false,
      email: true,
      sms: false,
      phone: '',
      weeklyDigest: true, // default-on because email defaults on
      phoneVerified: false,
    });
  });

  it('PUT /notifications/prefs persists toggles (verified phone) and weeklyDigest opt-out', async () => {
    const token = await loginAsSeed();
    await verifyPhone(token);
    const res = await request(app)
      .put('/notifications/prefs')
      .set('Authorization', `Bearer ${token}`)
      .send({ browser: true, email: false, sms: true, phone: PHONE, weeklyDigest: false });
    expect(res.status).toBe(200);
    expect(res.body.sms).toBe(true);
    expect(res.body.phone).toBe(PHONE);
    expect(res.body.weeklyDigest).toBe(false);
    const reread = await request(app)
      .get('/notifications/prefs')
      .set('Authorization', `Bearer ${token}`);
    expect(reread.body.phone).toBe(PHONE);
    expect(reread.body.weeklyDigest).toBe(false);
  });

  it('PUT /notifications/prefs rejects SMS without a valid phone', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .put('/notifications/prefs')
      .set('Authorization', `Bearer ${token}`)
      .send({ browser: false, email: false, sms: true, phone: '5551234567' });
    expect(res.status).toBe(400);
  });

  it('PUT /notifications/prefs rejects enabling SMS on an unverified phone', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .put('/notifications/prefs')
      .set('Authorization', `Bearer ${token}`)
      .send({ browser: false, email: true, sms: true, phone: PHONE });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Phone number must be verified before enabling SMS reminders');
  });

  it('disabling SMS keeps the verified phone; changing it clears verification', async () => {
    const token = await loginAsSeed();
    await verifyPhone(token);
    // SMS off: number + verified status persist (no re-verification needed).
    const off = await request(app)
      .put('/notifications/prefs')
      .set('Authorization', `Bearer ${token}`)
      .send({ browser: false, email: true, sms: false, phone: PHONE });
    expect(off.body.phone).toBe(PHONE);
    expect(off.body.phoneVerified).toBe(true);
    // New number: verification is cleared until confirmed again.
    const changed = await request(app)
      .put('/notifications/prefs')
      .set('Authorization', `Bearer ${token}`)
      .send({ browser: false, email: true, sms: false, phone: '+15559876543' });
    expect(changed.body.phoneVerified).toBe(false);
  });

  it('confirm-verification rejects a wrong code, burns attempts, locks at 5', async () => {
    const token = await loginAsSeed();
    const start = await request(app)
      .post('/notifications/phone/start-verification')
      .set('Authorization', `Bearer ${token}`)
      .send({ phone: PHONE });
    const wrongCode = start.body.devCode === '000000' ? '000001' : '000000';
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post('/notifications/phone/confirm-verification')
        .set('Authorization', `Bearer ${token}`)
        .send({ code: wrongCode });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Incorrect verification code.');
    }
    // Even the right code is locked out after 5 misses.
    const locked = await request(app)
      .post('/notifications/phone/confirm-verification')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: start.body.devCode });
    expect(locked.status).toBe(429);
  });

  it('confirm-verification without a pending code is a 400', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .post('/notifications/phone/confirm-verification')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: '123456' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Verification code expired or not found. Request a new code.');
  });
});

describe('weekly digest + year recap manual triggers', () => {
  it('POST /notifications/run-digests counts digest-enabled members when plants are overdue', async () => {
    const token = await loginAsSeed();
    // Seed task is due "now" (not overdue); push it into the past.
    db.tasks.get(seedTaskId)!.nextDue = new Date(
      Date.now() - 3 * 24 * 60 * 60 * 1000
    ).toISOString();
    const res = await request(app)
      .post('/notifications/run-digests')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(1); // seed admin has email + weeklyDigest defaults
  });

  it('POST /notifications/run-digests skips households with nothing overdue', async () => {
    const token = await loginAsSeed();
    db.tasks.get(seedTaskId)!.nextDue = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const res = await request(app)
      .post('/notifications/run-digests')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(0);
  });

  it('POST /notifications/run-digests skips members who opted out of the digest', async () => {
    const token = await loginAsSeed();
    db.tasks.get(seedTaskId)!.nextDue = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await request(app)
      .put('/notifications/prefs')
      .set('Authorization', `Bearer ${token}`)
      .send({ browser: false, email: true, sms: false, phone: '', weeklyDigest: false });
    const res = await request(app)
      .post('/notifications/run-digests')
      .set('Authorization', `Bearer ${token}`);
    expect(res.body.sent).toBe(0);
  });

  it('POST /notifications/run-digests requires admin', async () => {
    seedMember('member-1', 'member1@example.com', 'member');
    const login = await request(app)
      .post('/auth/login')
      .send({ email: 'member1@example.com', password: 'password-123' });
    const res = await request(app)
      .post('/notifications/run-digests')
      .set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(res.status).toBe(403);
  });

  it('POST /notifications/run-year-recap sends once per household per year', async () => {
    const token = await loginAsSeed();
    const year = new Date().getUTCFullYear() - 1;
    // One completion inside the recap year.
    db.completions.set('c1', {
      id: 'c1',
      householdId: seedHouseholdId,
      plantId: seedPlantId,
      taskId: seedTaskId,
      taskType: 'water',
      completedBy: seedUserId,
      completedByName: 'Test User',
      completedAt: `${year}-06-15T12:00:00.000Z`,
      notes: null,
    });
    const first = await request(app)
      .post('/notifications/run-year-recap')
      .set('Authorization', `Bearer ${token}`)
      .send({ year });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ sent: 1, year });
    // Retried run: once-per-year marker makes it a no-op.
    const second = await request(app)
      .post('/notifications/run-year-recap')
      .set('Authorization', `Bearer ${token}`)
      .send({ year });
    expect(second.body).toEqual({ sent: 0, year });
  });

  it('POST /notifications/run-year-recap with no completions that year sends nothing', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .post('/notifications/run-year-recap')
      .set('Authorization', `Bearer ${token}`)
      .send({ year: 2001 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: 0, year: 2001 });
  });
});

describe('public API + API keys', () => {
  it('POST /api-keys requires Greenhouse plan to issue', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .post('/api-keys')
      .set('Authorization', `Bearer ${token}`)
      .send({ label: 'try' });
    expect(res.status).toBe(402);
  });

  it('admin on Greenhouse can issue + use a key end-to-end', async () => {
    const token = await loginAsSeed();
    db.households.get(seedHouseholdId)!.planId = 'greenhouse';
    const create = await request(app)
      .post('/api-keys')
      .set('Authorization', `Bearer ${token}`)
      .send({ label: 'home assistant' });
    expect(create.status).toBe(201);
    expect(create.body.plaintext).toMatch(/^fg_[0-9a-f]{48}$/);

    const me = await request(app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${create.body.plaintext}`);
    expect(me.status).toBe(200);
    expect(me.body.householdId).toBe(seedHouseholdId);

    const plants = await request(app)
      .get('/api/v1/plants')
      .set('Authorization', `Bearer ${create.body.plaintext}`);
    expect(plants.status).toBe(200);
    expect(Array.isArray(plants.body)).toBe(true);
    // No scopes requested → full read surface granted.
    expect(create.body.record.scopes).toEqual(['read:plants', 'read:tasks', 'read:activity']);
  });

  it('a scoped key can only reach endpoints within its scopes', async () => {
    const token = await loginAsSeed();
    db.households.get(seedHouseholdId)!.planId = 'greenhouse';
    const create = await request(app)
      .post('/api-keys')
      .set('Authorization', `Bearer ${token}`)
      .send({ label: 'plants-only', scopes: ['read:plants'] });
    expect(create.status).toBe(201);
    expect(create.body.record.scopes).toEqual(['read:plants']);
    const key = create.body.plaintext as string;

    // /me is identity-only — always allowed.
    expect(
      (await request(app).get('/api/v1/me').set('Authorization', `Bearer ${key}`)).status
    ).toBe(200);
    // In-scope: plants succeeds.
    expect(
      (await request(app).get('/api/v1/plants').set('Authorization', `Bearer ${key}`)).status
    ).toBe(200);
    // Out-of-scope: tasks + activity are refused with 403 (not 401 — the key
    // is valid, just under-scoped).
    const tasks = await request(app).get('/api/v1/tasks').set('Authorization', `Bearer ${key}`);
    expect(tasks.status).toBe(403);
    expect(tasks.body.message).toMatch(/read:tasks/);
    expect(
      (await request(app).get('/api/v1/activity').set('Authorization', `Bearer ${key}`)).status
    ).toBe(403);
  });

  it('rejects an unknown scope at key creation', async () => {
    const token = await loginAsSeed();
    db.households.get(seedHouseholdId)!.planId = 'greenhouse';
    const res = await request(app)
      .post('/api-keys')
      .set('Authorization', `Bearer ${token}`)
      .send({ label: 'bad', scopes: ['read:everything'] });
    expect(res.status).toBe(400);
  });

  it('public API rejects missing or invalid keys with 401', async () => {
    const noKey = await request(app).get('/api/v1/plants');
    expect(noKey.status).toBe(401);
    const badKey = await request(app)
      .get('/api/v1/plants')
      .set('Authorization', 'Bearer fg_definitelynot');
    expect(badKey.status).toBe(401);
  });

  it('revoking a key locks out subsequent requests', async () => {
    const token = await loginAsSeed();
    db.households.get(seedHouseholdId)!.planId = 'greenhouse';
    const created = await request(app)
      .post('/api-keys')
      .set('Authorization', `Bearer ${token}`)
      .send({ label: 'temp' });
    const list = await request(app).get('/api-keys').set('Authorization', `Bearer ${token}`);
    const keyId = list.body[0].id;
    const revoke = await request(app)
      .delete(`/api-keys/${keyId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(revoke.status).toBe(204);
    const after = await request(app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${created.body.plaintext}`);
    expect(after.status).toBe(401);
  });
});

describe('multi-household via X-Household-Id', () => {
  it('403s an X-Household-Id override naming a household the caller is NOT a member of', async () => {
    const token = await loginAsSeed();
    const otherHouseholdId = '11111111-1111-1111-1111-111111111111';
    db.households.set(otherHouseholdId, {
      id: otherHouseholdId,
      name: 'Other house',
      createdAt: new Date().toISOString(),
      createdBy: 'someone-else',
    });
    // The seed user has NO membership in otherHouseholdId. Production's
    // authMiddleware validates the override against the membership table
    // and rejects — honoring the header here was the security inversion
    // that let any caller read any household.
    const res = await request(app)
      .get(`/households/${otherHouseholdId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Household-Id', otherHouseholdId);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Not a member of the requested household');
  });

  it('honors the override for a household the caller IS a member of, with the membership role', async () => {
    const token = await loginAsSeed();
    const create = await request(app)
      .post('/households')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Second house' });
    const newId = create.body.id as string;
    const res = await request(app)
      .get(`/households/${newId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Household-Id', newId);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Second house');
  });
});

describe('activity feed (enriched)', () => {
  it('emits plant.created events into the activity feed', async () => {
    const token = await loginAsSeed();
    await request(app)
      .post('/plants')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'New Pothos' });
    const res = await request(app)
      .get(`/households/${seedHouseholdId}/activity`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const types = res.body.map((e: { type: string }) => e.type);
    expect(types).toContain('plant.created');
  });
});

describe('account', () => {
  it('change-password rejects wrong current password', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ oldPassword: 'wrong', newPassword: 'longenoughnewpw' });
    expect(res.status).toBe(401);
  });

  it('change-password updates the seed user password', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ oldPassword: SEED_PASSWORD, newPassword: 'aBrandNewPassword1' });
    expect(res.status).toBe(200);
    const login = await request(app)
      .post('/auth/login')
      .send({ email: SEED_EMAIL, password: 'aBrandNewPassword1' });
    expect(login.status).toBe(200);
  });

  it('PATCH /auth/me updates the user name and reflects in /auth/me', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .patch('/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Renamed Person' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Renamed Person');
    const me = await request(app).get('/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.body.name).toBe('Renamed Person');
  });

  it('PATCH /auth/me rejects empty names', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .patch('/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: '   ' });
    expect(res.status).toBe(400);
  });
});

describe('billing', () => {
  it('GET /billing/plans is public and lists three tiers', async () => {
    const res = await request(app).get('/billing/plans');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      paymentsAvailable: false,
      commercialHold: { active: true, effectiveDate: '2026-07-14' },
    });
    expect(res.body.plans.map((p: { id: string }) => p.id)).toEqual([
      'seedling',
      'garden',
      'greenhouse',
    ]);
    for (const plan of res.body.plans) {
      expect(plan).not.toHaveProperty('monthlyPrice');
      expect(plan).not.toHaveProperty('annualPrice');
      expect(plan).not.toHaveProperty('lifetimePrice');
    }
  });

  it('GET /billing/me defaults to seedling', async () => {
    const token = await loginAsSeed();
    const res = await request(app).get('/billing/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.planId).toBe('seedling');
  });

  it('admin checkout fails closed without changing the plan', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .post('/billing/checkout')
      .set('Authorization', `Bearer ${token}`)
      .send({ planId: 'garden' });
    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/payments are currently paused/i);
    const me = await request(app).get('/billing/me').set('Authorization', `Bearer ${token}`);
    expect(me.body.planId).toBe('seedling');
  });

  it('admin portal access also fails closed', async () => {
    const token = await loginAsSeed();
    const res = await request(app).post('/billing/portal').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/billing access is currently paused/i);
  });

  it('non-admin cannot checkout', async () => {
    seedMember('member-2', 'm2@example.com', 'member');
    const login = await request(app)
      .post('/auth/login')
      .send({ email: 'm2@example.com', password: 'password-123' });
    const res = await request(app)
      .post('/billing/checkout')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .send({ planId: 'garden' });
    expect(res.status).toBe(403);
  });
});

describe('plan limits', () => {
  it('Seedling plan caps plant creation at 10', async () => {
    const token = await loginAsSeed();
    // The seed already has 1 plant. Add 9 more to hit the cap.
    for (let i = 0; i < 9; i++) {
      const r = await request(app)
        .post('/plants')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: `Plant ${i}` });
      expect(r.status).toBe(201);
    }
    const overflow = await request(app)
      .post('/plants')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'one too many' });
    expect(overflow.status).toBe(402);
  });

  it('a retained Garden entitlement lifts the cap', async () => {
    const token = await loginAsSeed();
    // Cap out on Seedling.
    for (let i = 0; i < 9; i++) {
      await request(app)
        .post('/plants')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: `Plant ${i}` });
    }
    // Seed the retained entitlement architecture directly; public checkout is
    // intentionally unavailable during the commercial hold.
    db.households.get(seedHouseholdId)!.planId = 'garden';
    const after = await request(app)
      .post('/plants')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'eleventh' });
    expect(after.status).toBe(201);
  });
});

describe('climate', () => {
  it('returns configured:false and no tips when integration is unconfigured', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .get(`/households/${seedHouseholdId}/climate`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ configured: false, weather: null, tips: [] });
  });

  it('saves a household location (climate reads never echo it — production contract)', async () => {
    const token = await loginAsSeed();
    const set = await request(app)
      .put(`/households/${seedHouseholdId}/location`)
      .set('Authorization', `Bearer ${token}`)
      .send({ city: 'Austin, US' });
    expect(set.status).toBe(200);
    expect(set.body.location.city).toBe('Austin, US');

    // Production getClimate returns exactly { configured, weather, tips } —
    // the mock used to add a `location` field production never returns.
    const climate = await request(app)
      .get(`/households/${seedHouseholdId}/climate`)
      .set('Authorization', `Bearer ${token}`);
    expect(climate.status).toBe(200);
    expect(climate.body.location).toBeUndefined();
    expect(Object.keys(climate.body).sort()).toEqual(['configured', 'tips', 'weather']);
  });

  it('403s climate reads for a household the caller does not belong to', async () => {
    const otherToken = await createConfirmedUser('clim@example.com');
    await request(app)
      .post('/households')
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ name: 'Climate Home' });
    const res = await request(app)
      .get(`/households/${seedHouseholdId}/climate`)
      .set('Authorization', `Bearer ${otherToken}`);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Access denied');
  });

  it('rejects empty location payload', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .put(`/households/${seedHouseholdId}/location`)
      .set('Authorization', `Bearer ${token}`)
      .send({ city: '   ' });
    expect(res.status).toBe(400);
  });
});

describe('multi-household per user', () => {
  it('a user can create a second household without losing the first', async () => {
    const token = await loginAsSeed();
    const create = await request(app)
      .post('/households')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Vacation Home' });
    expect(create.status).toBe(201);
    const newId = create.body.id as string;

    const list = await request(app).get('/me/households').set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    const ids = list.body.map((m: { householdId: string }) => m.householdId);
    expect(ids).toContain(seedHouseholdId);
    expect(ids).toContain(newId);
  });

  it('an X-Household-Id header pins requests to the addressed household', async () => {
    const token = await loginAsSeed();
    const create = await request(app)
      .post('/households')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Beach Cottage' });
    const newId = create.body.id as string;

    // Default household still has its seeded plant…
    const defaultPlants = await request(app).get('/plants').set('Authorization', `Bearer ${token}`);
    expect(defaultPlants.body.length).toBeGreaterThan(0);

    // …but the new one is empty.
    const newPlants = await request(app)
      .get('/plants')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Household-Id', newId);
    expect(newPlants.status).toBe(200);
    expect(newPlants.body).toEqual([]);
  });

  it('the user is admin of any household they created — even when X-Household-Id is set', async () => {
    const token = await loginAsSeed();
    const create = await request(app)
      .post('/households')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Treehouse' });
    const newId = create.body.id as string;

    // run-reminders is admin-gated; a successful 200 confirms role is
    // 'admin' for the addressed household, not downgraded to 'member'.
    const res = await request(app)
      .post('/notifications/run-reminders')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Household-Id', newId);
    expect(res.status).toBe(200);
  });
});

describe('cross-household isolation', () => {
  it('a different household cannot see the seed household plants', async () => {
    const token = await createConfirmedUser('iso@example.com');
    await request(app)
      .post('/households')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Iso Home' });

    const res = await request(app).get('/plants').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('GET /me/export', () => {
  it('requires auth', async () => {
    const res = await request(app).get('/me/export');
    expect(res.status).toBe(401);
  });

  it('returns a downloadable JSON document of the caller data', async () => {
    const token = await loginAsSeed();
    const res = await request(app).get('/me/export').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('family-greenhouse-export.json');
    expect(res.headers['cache-control']).toBe('no-store');

    const body = JSON.parse(res.text) as {
      format: string;
      user: { id: string; email: string };
      notificationPreferences: unknown;
      households: { id: string; plants: unknown[]; tasks: unknown[] }[];
    };
    expect(body.format).toBe('family-greenhouse-export');
    expect(body.user.email).toBe(SEED_EMAIL);
    expect(body.user.id).toBe(seedUserId);
    expect(body.notificationPreferences).toBeTruthy();

    // The seed household, with its seeded plant and task, is present.
    const seed = body.households.find((h) => h.id === seedHouseholdId);
    expect(seed).toBeTruthy();
    expect(seed!.plants.some((p) => (p as { id: string }).id === seedPlantId)).toBe(true);
    expect(seed!.tasks.some((t) => (t as { id: string }).id === seedTaskId)).toBe(true);
  });

  it('spans every household the user belongs to', async () => {
    const token = await loginAsSeed();
    const create = await request(app)
      .post('/households')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Second Home' });
    const newId = create.body.id as string;

    const res = await request(app).get('/me/export').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const ids = (JSON.parse(res.text).households as { id: string }[]).map((h) => h.id);
    expect(ids).toContain(seedHouseholdId);
    expect(ids).toContain(newId);
  });
});

describe('production contract details', () => {
  it('GET /species/:id/thumbnail is unauthenticated (served to anonymous <img> tags)', async () => {
    const res = await request(app).get('/species/123/thumbnail');
    // No enrichment locally → 404, but crucially NOT 401.
    expect(res.status).toBe(404);
  });

  it('unknown routes return the production JSON 404 shape', async () => {
    const res = await request(app).get('/definitely/not/a/route');
    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/^No route handler for /);
  });

  it('malformed JSON bodies are a 400, not a 500', async () => {
    const res = await request(app)
      .post('/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": ');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: 'Invalid JSON body' });
  });
});
