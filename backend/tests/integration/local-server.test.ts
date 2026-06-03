import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  app,
  db,
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
    it('creates a pending user and returns id', async () => {
      const res = await request(app)
        .post('/auth/signup')
        .send({ email: 'new@example.com', password: 'pw1', name: 'New User' });
      expect(res.status).toBe(201);
      expect(res.body.userId).toBeTruthy();
      const created = db.users.get(res.body.userId);
      expect(created?.confirmed).toBe(false);
      expect(db.pendingConfirmations.get('new@example.com')).toBe('123456');
    });

    it('rejects missing fields', async () => {
      const res = await request(app).post('/auth/signup').send({ email: 'a@b.com' });
      expect(res.status).toBe(400);
    });

    it('rejects duplicate email', async () => {
      const res = await request(app)
        .post('/auth/signup')
        .send({ email: SEED_EMAIL, password: 'x', name: 'Dup' });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /auth/confirm', () => {
    it('confirms the user with the right code and returns tokens', async () => {
      await request(app)
        .post('/auth/signup')
        .send({ email: 'c@example.com', password: 'pw', name: 'C' });
      const res = await request(app)
        .post('/auth/confirm')
        .send({ email: 'c@example.com', code: '123456' });
      expect(res.status).toBe(200);
      expect(res.body.accessToken).toMatch(/^mock-token-/);
      expect(res.body.user.email).toBe('c@example.com');
    });

    it('rejects invalid code', async () => {
      await request(app)
        .post('/auth/signup')
        .send({ email: 'd@example.com', password: 'pw', name: 'D' });
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
      await request(app)
        .post('/auth/signup')
        .send({ email: 'u@example.com', password: 'pw', name: 'U' });
      const res = await request(app)
        .post('/auth/login')
        .send({ email: 'u@example.com', password: 'pw' });
      expect(res.status).toBe(401);
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
    });

    it('rejects garbage refresh tokens', async () => {
      const res = await request(app).post('/auth/refresh').send({ refreshToken: 'nope' });
      expect(res.status).toBe(401);
    });

    it('requires a refresh token', async () => {
      const res = await request(app).post('/auth/refresh').send({});
      expect(res.status).toBe(400);
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
      await request(app)
        .post('/auth/signup')
        .send({ email: 'r@example.com', password: 'pw', name: 'R' });
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
    await request(app)
      .post('/auth/signup')
      .send({ email: 'h@example.com', password: 'pw', name: 'H' });
    const confirm = await request(app)
      .post('/auth/confirm')
      .send({ email: 'h@example.com', code: '123456' });
    const token = confirm.body.accessToken as string;

    const res = await request(app)
      .post('/households')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'New Home' });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe('admin');
    expect(res.body.id).toBeTruthy();
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

  it('returns 404 for unknown household', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .get('/households/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
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

  it('creates a task scheduled `frequency` days in the future', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .post('/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ plantId: seedPlantId, type: 'fertilize', frequency: 14 });
    expect(res.status).toBe(201);
    const due = new Date(res.body.nextDue).getTime();
    const expected = Date.now() + 14 * 24 * 60 * 60 * 1000;
    expect(Math.abs(due - expected)).toBeLessThan(60 * 1000);
  });

  it('refuses to create a task on a plant from a different household', async () => {
    await request(app)
      .post('/auth/signup')
      .send({ email: 'x@example.com', password: 'pw', name: 'X' });
    const confirm = await request(app)
      .post('/auth/confirm')
      .send({ email: 'x@example.com', code: '123456' });
    const otherToken = confirm.body.accessToken as string;
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
    db.users.set('user-2', {
      id: 'user-2',
      email: 'two@example.com',
      password: 'pw',
      name: 'Two',
      confirmed: true,
      householdId: seedHouseholdId,
      householdRole: 'member',
    });
    const token = await loginAsSeed();
    const res = await request(app)
      .put(`/households/${seedHouseholdId}/members/user-2/role`)
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'admin' });
    expect(res.status).toBe(200);
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
    db.users.set('user-3', {
      id: 'user-3',
      email: 'three@example.com',
      password: 'pw',
      name: 'Three',
      confirmed: true,
      householdId: seedHouseholdId,
      householdRole: 'member',
    });
    const login = await request(app)
      .post('/auth/login')
      .send({ email: 'three@example.com', password: 'pw' });
    const res = await request(app)
      .put(`/households/${seedHouseholdId}/members/${seedUserId}/role`)
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .send({ role: 'member' });
    expect(res.status).toBe(403);
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

  it('rejects bogus days', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .post(`/tasks/${seedTaskId}/snooze`)
      .set('Authorization', `Bearer ${token}`)
      .send({ days: 0 });
    expect(res.status).toBe(400);
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
    await request(app)
      .post('/auth/signup')
      .send({ email: 'q@example.com', password: 'pw', name: 'Q' });
    const confirm = await request(app)
      .post('/auth/confirm')
      .send({ email: 'q@example.com', code: '123456' });
    const otherToken = confirm.body.accessToken as string;
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
  it('GET /notifications/prefs returns defaults for a fresh user', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .get('/notifications/prefs')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ browser: false, email: true, sms: false, phone: '' });
  });

  it('PUT /notifications/prefs persists toggles', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .put('/notifications/prefs')
      .set('Authorization', `Bearer ${token}`)
      .send({ browser: true, email: false, sms: true, phone: '+15551234567' });
    expect(res.status).toBe(200);
    expect(res.body.sms).toBe(true);
    expect(res.body.phone).toBe('+15551234567');
    const reread = await request(app)
      .get('/notifications/prefs')
      .set('Authorization', `Bearer ${token}`);
    expect(reread.body.phone).toBe('+15551234567');
  });

  it('PUT /notifications/prefs rejects SMS without a valid phone', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .put('/notifications/prefs')
      .set('Authorization', `Bearer ${token}`)
      .send({ browser: false, email: false, sms: true, phone: '5551234567' });
    expect(res.status).toBe(400);
  });

  it('disabling SMS clears the stored phone number', async () => {
    const token = await loginAsSeed();
    await request(app)
      .put('/notifications/prefs')
      .set('Authorization', `Bearer ${token}`)
      .send({ browser: false, email: true, sms: true, phone: '+15551234567' });
    const off = await request(app)
      .put('/notifications/prefs')
      .set('Authorization', `Bearer ${token}`)
      .send({ browser: false, email: true, sms: false, phone: '+15551234567' });
    expect(off.body.phone).toBe('');
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
    await request(app)
      .post('/billing/checkout')
      .set('Authorization', `Bearer ${token}`)
      .send({ planId: 'greenhouse' });
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
    await request(app)
      .post('/billing/checkout')
      .set('Authorization', `Bearer ${token}`)
      .send({ planId: 'greenhouse' });
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
    await request(app)
      .post('/billing/checkout')
      .set('Authorization', `Bearer ${token}`)
      .send({ planId: 'greenhouse' });
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
    await request(app)
      .post('/billing/checkout')
      .set('Authorization', `Bearer ${token}`)
      .send({ planId: 'greenhouse' });
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
  it('routes scope to the header household when present', async () => {
    const token = await loginAsSeed();
    const otherHouseholdId = '11111111-1111-1111-1111-111111111111';
    db.households.set(otherHouseholdId, {
      id: otherHouseholdId,
      name: 'Other house',
      createdAt: new Date().toISOString(),
      createdBy: seedUserId,
    });
    const res = await request(app)
      .get(`/households/${otherHouseholdId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Household-Id', otherHouseholdId);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Other house');
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
    expect(res.body.length).toBe(3);
    expect(res.body.map((p: { id: string }) => p.id)).toEqual(['seedling', 'garden', 'greenhouse']);
  });

  it('GET /billing/me defaults to seedling', async () => {
    const token = await loginAsSeed();
    const res = await request(app).get('/billing/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.planId).toBe('seedling');
  });

  it('admin can checkout (dev mode flips plan immediately)', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .post('/billing/checkout')
      .set('Authorization', `Bearer ${token}`)
      .send({ planId: 'garden' });
    expect(res.status).toBe(200);
    expect(res.body.url).toContain('/billing/dev-success');
    const me = await request(app).get('/billing/me').set('Authorization', `Bearer ${token}`);
    expect(me.body.planId).toBe('garden');
  });

  it('non-admin cannot checkout', async () => {
    db.users.set('member-2', {
      id: 'member-2',
      email: 'm2@example.com',
      password: 'pw',
      name: 'M2',
      confirmed: true,
      householdId: seedHouseholdId,
      householdRole: 'member',
    });
    const login = await request(app)
      .post('/auth/login')
      .send({ email: 'm2@example.com', password: 'pw' });
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

  it('upgrading to Garden lifts the cap', async () => {
    const token = await loginAsSeed();
    // Cap out on Seedling.
    for (let i = 0; i < 9; i++) {
      await request(app)
        .post('/plants')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: `Plant ${i}` });
    }
    // Upgrade.
    await request(app)
      .post('/billing/checkout')
      .set('Authorization', `Bearer ${token}`)
      .send({ planId: 'garden' });
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

  it('saves a household location and reflects it on subsequent climate reads', async () => {
    const token = await loginAsSeed();
    const set = await request(app)
      .put(`/households/${seedHouseholdId}/location`)
      .set('Authorization', `Bearer ${token}`)
      .send({ city: 'Austin, US' });
    expect(set.status).toBe(200);
    expect(set.body.location.city).toBe('Austin, US');

    const climate = await request(app)
      .get(`/households/${seedHouseholdId}/climate`)
      .set('Authorization', `Bearer ${token}`);
    expect(climate.status).toBe(200);
    expect(climate.body.location.city).toBe('Austin, US');
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
    await request(app)
      .post('/auth/signup')
      .send({ email: 'iso@example.com', password: 'pw', name: 'Iso' });
    const confirm = await request(app)
      .post('/auth/confirm')
      .send({ email: 'iso@example.com', code: '123456' });
    const token = confirm.body.accessToken as string;
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
