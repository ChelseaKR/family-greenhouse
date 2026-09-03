/**
 * End-to-end Away Kit flows against the mock dev server (which mirrors the
 * production handlers — see local-server.ts contract note): sitter photo-back
 * through a live link, every server-side refusal (plan, expiry, revocation,
 * cross-household task, non-image bytes, size, the 60-per-link cap, the
 * per-token brake), and the members-only return recap that replays what the
 * sitter did — with its explicit "no window has ended" and locked states.
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
import {
  SITTER_PHOTO_MAX_BYTES,
  __resetSitterPhotoLimiterForTests,
} from '../../src/services/sitterPhotoPolicy';

const SEED_EMAIL = 'test@example.com';
const SEED_PASSWORD = 'password123';

/** A real 1×1 transparent PNG. */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const JPEG_B64 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60)]).toString(
  'base64'
);

async function loginAsSeed(): Promise<string> {
  const res = await request(app)
    .post('/auth/login')
    .send({ email: SEED_EMAIL, password: SEED_PASSWORD });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function loginAs(email: string, password: string): Promise<string> {
  const res = await request(app).post('/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

/** Direct local fixture → login → own household; returns the token. */
async function createUserWithHousehold(email: string, householdName: string): Promise<string> {
  provisionLocalUserFixture({ email, password: 'password-123', name: 'Neighbor' });
  const token = await loginAs(email, 'password-123');
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
function inPast(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function seedPlan(planId: 'seedling' | 'garden' | 'greenhouse') {
  db.households.get(seedHouseholdId)!.planId = planId;
}

async function createLink(
  adminToken: string,
  opts: { days?: number; label?: string } = {}
): Promise<{ id: string; token: string }> {
  const res = await request(app)
    .post(`/households/${seedHouseholdId}/sitter-links`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ expiresAt: inFuture(opts.days ?? 7), label: opts.label ?? 'Our plants' });
  expect(res.status).toBe(201);
  return { id: res.body.id as string, token: res.body.token as string };
}

function upload(token: string, body: Record<string, unknown>) {
  return request(app).post(`/sitter/${token}/photos`).send(body);
}

beforeEach(() => {
  resetDb();
  __resetSitterPhotoLimiterForTests();
});

const originalLog = console.log;
beforeEach(() => {
  console.log = () => {};
});
afterEach(() => {
  console.log = originalLog;
});

describe('sitter photo-back (public, token-authorised)', () => {
  it('reports status, stores an in-spec photo on the plant timeline as viaSitter, and emits the activity event', async () => {
    const admin = await loginAsSeed();
    seedPlan('garden');
    const link = await createLink(admin);

    const before = await request(app).get(`/sitter/${link.token}/photos`);
    expect(before.status).toBe(200);
    expect(before.body).toEqual({ enabled: true, max: 60, used: 0, remaining: 60 });

    const res = await upload(link.token, {
      taskId: seedTaskId,
      image: `data:image/png;base64,${PNG_B64}`,
      caption: 'New leaf unfurling!',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ caption: 'New leaf unfurling!', used: 1, remaining: 59 });
    // The acknowledgement is PII-free: no household id, no plant id, no
    // stored URL (its key path carries both), no link id.
    expect(JSON.stringify(res.body)).not.toContain(seedHouseholdId);
    expect(JSON.stringify(res.body)).not.toContain(seedPlantId);
    expect(res.body.imageUrl).toBeUndefined();

    // Household members see it on the plant's timeline, attributed to the link…
    const photos = await request(app)
      .get(`/plants/${seedPlantId}/photos`)
      .set('Authorization', `Bearer ${admin}`);
    expect(photos.status).toBe(200);
    expect(photos.body).toHaveLength(1);
    expect(photos.body[0]).toMatchObject({
      id: res.body.photoId,
      viaSitter: true,
      sitterLinkId: link.id,
      uploadedBy: `sitter:${link.id}`,
      caption: 'New leaf unfurling!',
    });
    const imageUrl = photos.body[0].imageUrl as string;
    expect(imageUrl).toMatch(
      new RegExp(`/mock-images/plants/${seedHouseholdId}/${seedPlantId}/[0-9a-f-]{36}\\.png$`)
    );

    // The object is served back with the SNIFFED type (the request declared
    // nothing the server trusted).
    const img = await request(app).get(new URL(imageUrl).pathname);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toContain('image/png');

    // …but the plant's primary image is NOT replaced by a sitter upload.
    const plant = await request(app)
      .get(`/plants/${seedPlantId}`)
      .set('Authorization', `Bearer ${admin}`);
    expect(plant.body.imageUrl ?? null).not.toBe(imageUrl);

    // The existing photo.uploaded event, flagged viaSitter with the link id.
    const activity = await request(app)
      .get(`/households/${seedHouseholdId}/activity`)
      .set('Authorization', `Bearer ${admin}`);
    const event = activity.body.find((e: { type: string }) => e.type === 'photo.uploaded');
    expect(event).toMatchObject({
      actorId: `sitter:${link.id}`,
      actorName: 'a plant sitter',
      payload: { viaSitter: true, sitterLinkId: link.id, plantId: seedPlantId },
    });

    const after = await request(app).get(`/sitter/${link.token}/photos`);
    expect(after.body).toEqual({ enabled: true, max: 60, used: 1, remaining: 59 });
  });

  it('is gated on the plan: a Seedling household’s link stores nothing (402) and reports enabled: false', async () => {
    const admin = await loginAsSeed();
    seedPlan('seedling');
    const link = await createLink(admin);

    const status = await request(app).get(`/sitter/${link.token}/photos`);
    expect(status.body).toEqual({ enabled: false, max: 60, used: null, remaining: null });

    const res = await upload(link.token, { taskId: seedTaskId, image: PNG_B64 });
    expect(res.status).toBe(402);
    expect(db.photos.size).toBe(0);
    expect(db.mockImages.size).toBe(0);
  });

  it('refuses after the link’s expiresAt and after revocation — same generic 404, nothing stored', async () => {
    const admin = await loginAsSeed();
    seedPlan('garden');
    const link = await createLink(admin);

    db.sitterLinks.get(link.token)!.expiresAt = inPast(1);
    const expired = await upload(link.token, { taskId: seedTaskId, image: PNG_B64 });
    expect(expired.status).toBe(404);
    expect((await request(app).get(`/sitter/${link.token}/photos`)).status).toBe(404);

    const fresh = await createLink(admin);
    const revoke = await request(app)
      .delete(`/households/${seedHouseholdId}/sitter-links/${fresh.id}`)
      .set('Authorization', `Bearer ${admin}`);
    expect(revoke.status).toBe(204);
    const revoked = await upload(fresh.token, { taskId: seedTaskId, image: PNG_B64 });
    expect(revoked.status).toBe(404);
    expect(revoked.body.message).toBe(expired.body.message);

    const unknown = await upload('0'.repeat(64), { taskId: seedTaskId, image: PNG_B64 });
    expect(unknown.status).toBe(404);
    expect(unknown.body.message).toBe(expired.body.message);

    expect(db.photos.size).toBe(0);
  });

  it('refuses a task from another household (scoped lookup → 404)', async () => {
    const admin = await loginAsSeed();
    seedPlan('garden');
    const link = await createLink(admin);

    const neighbor = await createUserWithHousehold('neighbor@example.com', 'Next door');
    const plant = await request(app)
      .post('/plants')
      .set('Authorization', `Bearer ${neighbor}`)
      .send({ name: 'Their Ficus' });
    expect(plant.status).toBe(201);
    const task = await request(app)
      .post('/tasks')
      .set('Authorization', `Bearer ${neighbor}`)
      .send({ plantId: plant.body.id, type: 'water', frequency: 7 });
    expect(task.status).toBe(201);

    const res = await upload(link.token, { taskId: task.body.id, image: PNG_B64 });
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Task not found');
    expect(db.photos.size).toBe(0);
  });

  it('validates the bytes, not the header: non-image content, oversize, and malformed bodies are refused', async () => {
    const admin = await loginAsSeed();
    seedPlan('garden');
    const link = await createLink(admin);

    const html = Buffer.from('<!doctype html><html><body>not a leaf</body></html>'.padEnd(80));
    const notImage = await upload(link.token, {
      taskId: seedTaskId,
      image: `data:image/jpeg;base64,${html.toString('base64')}`,
    });
    expect(notImage.status).toBe(400);
    expect(notImage.body.message).toBe('Photo is not a JPEG, PNG, or WebP image');

    const tooBig = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(SITTER_PHOTO_MAX_BYTES),
    ]);
    const oversize = await upload(link.token, {
      taskId: seedTaskId,
      image: tooBig.toString('base64'),
    });
    expect([400, 413]).toContain(oversize.status);

    // Exactly at the cap is accepted.
    const atCap = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(SITTER_PHOTO_MAX_BYTES - 8),
    ]);
    const ok = await upload(link.token, { taskId: seedTaskId, image: atCap.toString('base64') });
    expect(ok.status).toBe(201);

    const garbage = await upload(link.token, { taskId: seedTaskId, image: 'x'.repeat(65) + '!' });
    expect(garbage.status).toBe(400);

    const noTask = await upload(link.token, { image: PNG_B64 });
    expect(noTask.status).toBe(400);

    const longCaption = await upload(link.token, {
      taskId: seedTaskId,
      image: PNG_B64,
      caption: 'x'.repeat(201),
    });
    expect(longCaption.status).toBe(400);

    expect(db.photos.size).toBe(1);
  });

  it('enforces the 60-photo cap per link (409) and the per-token brake (429)', async () => {
    const admin = await loginAsSeed();
    seedPlan('garden');
    const link = await createLink(admin);

    db.sitterLinks.get(link.token)!.photoCount = 60;
    const full = await upload(link.token, { taskId: seedTaskId, image: JPEG_B64 });
    expect(full.status).toBe(409);
    expect(full.body.message).toContain('60-photo limit');
    const status = await request(app).get(`/sitter/${link.token}/photos`);
    expect(status.body).toEqual({ enabled: true, max: 60, used: 60, remaining: 0 });
    expect(db.photos.size).toBe(0);

    // A different link on the same household has its own cap, and its own
    // per-minute brake: 10 uploads pass, the 11th is 429.
    const other = await createLink(admin);
    for (let i = 0; i < 10; i++) {
      const r = await upload(other.token, { taskId: seedTaskId, image: JPEG_B64 });
      expect(r.status).toBe(201);
    }
    const braked = await upload(other.token, { taskId: seedTaskId, image: JPEG_B64 });
    expect(braked.status).toBe(429);
    expect(db.photos.size).toBe(10);
  });
});

describe('return recap (members-only)', () => {
  async function sitterCompletes(token: string) {
    const view = await request(app).get(`/sitter/${token}`);
    expect(view.status).toBe(200);
    const task = view.body.tasks.find((t: { taskId: string }) => t.taskId === seedTaskId);
    expect(task).toBeDefined();
    const done = await request(app)
      .post(`/sitter/${token}/tasks/${seedTaskId}/complete`)
      .send({ expectedNextDue: task.dueDate });
    expect(done.status).toBe(200);
  }

  it('replays what the sitter did inside the window of the most recently ended link', async () => {
    const admin = await loginAsSeed();
    seedPlan('garden');
    const link = await createLink(admin, { label: 'The Smiths’ plants' });

    await sitterCompletes(link.token);
    const photo = await upload(link.token, {
      taskId: seedTaskId,
      image: PNG_B64,
      caption: 'Watered and looking happy',
    });
    expect(photo.status).toBe(201);

    // The member's OWN completion during the window is not the sitter's.
    const own = await request(app)
      .post(`/tasks/${seedTaskId}/complete`)
      .set('Authorization', `Bearer ${admin}`)
      .send({});
    expect(own.status).toBe(200);

    // Nothing has ended yet → explicit 404, never an empty recap.
    const early = await request(app)
      .get(`/households/${seedHouseholdId}/away-recap`)
      .set('Authorization', `Bearer ${admin}`);
    expect(early.status).toBe(404);
    expect(early.body.message).toBe('No sitter window has ended yet');

    // …but an explicit linkId shows the in-progress window.
    const inProgress = await request(app)
      .get(`/households/${seedHouseholdId}/away-recap?linkId=${link.id}`)
      .set('Authorization', `Bearer ${admin}`);
    expect(inProgress.status).toBe(200);
    expect(inProgress.body.link.ended).toBe(false);

    db.sitterLinks.get(link.token)!.expiresAt = new Date(Date.now() - 1000).toISOString();

    const res = await request(app)
      .get(`/households/${seedHouseholdId}/away-recap`)
      .set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.link).toMatchObject({
      id: link.id,
      label: 'The Smiths’ plants',
      ended: true,
      status: 'active',
    });
    expect(res.body.counts).toEqual({ tasks: 1, photos: 1, notes: 1 });
    expect(res.body.tasksCompleted).toHaveLength(1);
    expect(res.body.tasksCompleted[0]).toMatchObject({
      taskId: seedTaskId,
      plantId: seedPlantId,
      taskType: 'water',
      actorName: 'a plant sitter',
    });
    expect(res.body.photos[0]).toMatchObject({
      photoId: photo.body.photoId,
      plantId: seedPlantId,
      caption: 'Watered and looking happy',
    });
    expect(res.body.photos[0].imageUrl).toMatch(/\/mock-images\/plants\//);
    expect(res.body.notes).toEqual([
      expect.objectContaining({ source: 'photo', text: 'Watered and looking happy' }),
    ]);
    expect(res.body.truncated).toBe(false);
    // The secret token is never in the recap.
    expect(JSON.stringify(res.body)).not.toContain(link.token);
  });

  it('is readable by a plain member, not only the admin who minted the link', async () => {
    const admin = await loginAsSeed();
    seedPlan('garden');
    const link = await createLink(admin);
    await sitterCompletes(link.token);
    db.sitterLinks.get(link.token)!.expiresAt = new Date(Date.now() - 1000).toISOString();

    const invite = await request(app)
      .post(`/households/${seedHouseholdId}/invites`)
      .set('Authorization', `Bearer ${admin}`);
    expect(invite.status).toBe(201);
    provisionLocalUserFixture({
      email: 'member@example.com',
      password: 'password-123',
      name: 'Bo',
    });
    const member = await loginAs('member@example.com', 'password-123');
    const join = await request(app)
      .post(`/households/join/${invite.body.code}`)
      .set('Authorization', `Bearer ${member}`);
    expect(join.status).toBe(200);

    const res = await request(app)
      .get(`/households/${seedHouseholdId}/away-recap`)
      .set('Authorization', `Bearer ${member}`);
    expect(res.status).toBe(200);
    expect(res.body.counts.tasks).toBe(1);
  });

  it('answers 402 on a Seedling household and 403 from another household', async () => {
    const admin = await loginAsSeed();
    seedPlan('seedling');
    const locked = await request(app)
      .get(`/households/${seedHouseholdId}/away-recap`)
      .set('Authorization', `Bearer ${admin}`);
    expect(locked.status).toBe(402);

    seedPlan('garden');
    const neighbor = await createUserWithHousehold('neighbor@example.com', 'Next door');
    const forbidden = await request(app)
      .get(`/households/${seedHouseholdId}/away-recap`)
      .set('Authorization', `Bearer ${neighbor}`);
    expect(forbidden.status).toBe(403);
  });

  it('treats a revoked link as ended and 404s an unknown linkId', async () => {
    const admin = await loginAsSeed();
    seedPlan('garden');
    const link = await createLink(admin);
    await sitterCompletes(link.token);
    const revoke = await request(app)
      .delete(`/households/${seedHouseholdId}/sitter-links/${link.id}`)
      .set('Authorization', `Bearer ${admin}`);
    expect(revoke.status).toBe(204);

    const res = await request(app)
      .get(`/households/${seedHouseholdId}/away-recap`)
      .set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.link).toMatchObject({ id: link.id, status: 'revoked', ended: true });
    expect(res.body.counts.tasks).toBe(1);

    const missing = await request(app)
      .get(`/households/${seedHouseholdId}/away-recap?linkId=nope`)
      .set('Authorization', `Bearer ${admin}`);
    expect(missing.status).toBe(404);
    expect(missing.body.message).toBe('Sitter link not found');
  });
});
