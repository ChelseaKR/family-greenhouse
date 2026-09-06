/**
 * End-to-end flows for Plant Tags (ADR 0016) against the mock dev server,
 * which mirrors the production handlers. Covers what the unit tests can't:
 * the full issue → public scan → public complete → attribution-in-history →
 * re-issue → revoke lifecycle, the plan gate, the one-plant scope, the PIN
 * with its per-tag lockout, and the no-PII guarantee of the public payload.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
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

function onGarden(): void {
  db.households.get(seedHouseholdId)!.planId = 'garden';
}

async function issueSeedTag(auth: string): Promise<{ token: string; url: string; id: string }> {
  const res = await request(app)
    .post(`/plants/${seedPlantId}/tag`)
    .set('Authorization', `Bearer ${auth}`)
    .send();
  expect(res.status).toBe(201);
  return res.body as { token: string; url: string; id: string };
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

describe('plan gate', () => {
  it('Seedling cannot issue a tag (402); Garden can', async () => {
    const auth = await loginAsSeed();
    const refused = await request(app)
      .post(`/plants/${seedPlantId}/tag`)
      .set('Authorization', `Bearer ${auth}`)
      .send();
    expect(refused.status).toBe(402);
    expect(refused.body.message).toMatch(/Garden/);

    onGarden();
    const tag = await issueSeedTag(auth);
    expect(tag.token).toMatch(/^[0-9a-f]{64}$/);
    expect(tag.url).toContain(`/tag/${tag.token}`);
  });

  it('the household list reports tags with tokens, the PIN state and the allowance', async () => {
    const auth = await loginAsSeed();
    onGarden();
    const tag = await issueSeedTag(auth);
    const list = await request(app)
      .get(`/households/${seedHouseholdId}/plant-tags`)
      .set('Authorization', `Bearer ${auth}`);
    expect(list.status).toBe(200);
    expect(list.body.tags).toHaveLength(1);
    expect(list.body.tags[0]).toMatchObject({
      id: tag.id,
      plantId: seedPlantId,
      plantName: 'Monstera',
      token: tag.token,
    });
    expect(list.body.pinEnabled).toBe(false);
    expect(list.body.allowance).toEqual({ enabled: true, max: 50, used: 1 });
  });
});

describe('public scan + complete', () => {
  it('scans without auth, completes as "Grandma", and the household sees who did it', async () => {
    const auth = await loginAsSeed();
    onGarden();
    const { token } = await issueSeedTag(auth);
    db.households.get(seedHouseholdId)!.location = { city: 'Austin', lat: 30.27, lon: -97.74 };

    const scan = await request(app).get(`/tag/${token}`);
    expect(scan.status).toBe(200);
    expect(scan.body.plantName).toBe('Monstera');
    expect(scan.body.careNotes).toBe('Needs indirect light');
    // Real absence, reported as such: nothing has been done to this plant.
    expect(scan.body.history).toEqual({ status: 'ok', lastCare: null, lastWatered: null });
    expect(scan.body.tasks).toEqual([
      expect.objectContaining({ taskId: seedTaskId, taskType: 'water' }),
    ]);
    // PII-free: no member ids/emails, no household id, no saved location.
    const raw = JSON.stringify(scan.body);
    expect(raw).not.toContain(seedUserId);
    expect(raw).not.toContain(seedHouseholdId);
    expect(raw).not.toContain('test@example.com');
    expect(raw).not.toContain('Austin');

    const done = await request(app)
      .post(`/tag/${token}/tasks/${seedTaskId}/complete`)
      .send({ displayName: 'Grandma', expectedNextDue: scan.body.tasks[0].dueDate });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({
      taskId: seedTaskId,
      completedByName: 'Grandma',
      alreadyDone: false,
    });

    // The scan page now shows who last watered it.
    const again = await request(app).get(`/tag/${token}`);
    expect(again.body.history.lastWatered).toMatchObject({
      taskType: 'water',
      completedByName: 'Grandma',
      viaTag: true,
    });
    // The schedule advanced: the same task is no longer overdue and its due
    // date moved a full cycle out. (It stays listed because the seed task's
    // 7-day frequency lands exactly on the edge of the 7-day scan window.)
    expect(again.body.tasks[0]).toMatchObject({ taskId: seedTaskId, overdue: false });
    expect(Date.parse(again.body.tasks[0].dueDate)).toBeGreaterThan(
      Date.parse(scan.body.tasks[0].dueDate)
    );

    // Members see it on the plant's history and in the activity feed.
    const history = await request(app)
      .get(`/plants/${seedPlantId}/history`)
      .set('Authorization', `Bearer ${auth}`);
    expect(history.status).toBe(200);
    expect(history.body[0]).toMatchObject({ completedByName: 'Grandma' });
    expect(history.body[0].completedBy).toMatch(/^tag:/);

    const activity = await request(app)
      .get(`/households/${seedHouseholdId}/activity`)
      .set('Authorization', `Bearer ${auth}`);
    const event = activity.body.find((e: { type: string }) => e.type === 'task.completed');
    expect(event).toMatchObject({ actorName: 'Grandma', payload: { viaTag: true } });
  });

  it('a retried tap for the same occurrence is acknowledged, not completed twice', async () => {
    const auth = await loginAsSeed();
    onGarden();
    const { token } = await issueSeedTag(auth);
    const scan = await request(app).get(`/tag/${token}`);
    const dueDate = scan.body.tasks[0].dueDate as string;
    const first = await request(app)
      .post(`/tag/${token}/tasks/${seedTaskId}/complete`)
      .send({ displayName: 'Grandma', expectedNextDue: dueDate });
    expect(first.body.alreadyDone).toBe(false);
    const retry = await request(app)
      .post(`/tag/${token}/tasks/${seedTaskId}/complete`)
      .send({ displayName: 'Grandma', expectedNextDue: dueDate });
    expect(retry.status).toBe(200);
    expect(retry.body.alreadyDone).toBe(true);
    const completions = [...db.completions.values()].filter((c) => c.plantId === seedPlantId);
    expect(completions).toHaveLength(1);
  });

  it('cannot complete a task on a SIBLING plant in the same household (one-plant scope)', async () => {
    const auth = await loginAsSeed();
    onGarden();
    const { token } = await issueSeedTag(auth);
    const siblingPlantId = uuidv4();
    const siblingTaskId = uuidv4();
    const now = new Date().toISOString();
    db.plants.set(siblingPlantId, {
      ...db.plants.get(seedPlantId)!,
      id: siblingPlantId,
      name: 'Pothos',
    });
    db.tasks.set(siblingTaskId, {
      ...db.tasks.get(seedTaskId)!,
      id: siblingTaskId,
      plantId: siblingPlantId,
      plantName: 'Pothos',
      nextDue: now,
    });
    const res = await request(app)
      .post(`/tag/${token}/tasks/${siblingTaskId}/complete`)
      .send({ displayName: 'Grandma' });
    expect(res.status).toBe(404);
    expect(db.tasks.get(siblingTaskId)!.lastCompleted).toBeNull();
  });

  it('requires a display name', async () => {
    const auth = await loginAsSeed();
    onGarden();
    const { token } = await issueSeedTag(auth);
    const res = await request(app).post(`/tag/${token}/tasks/${seedTaskId}/complete`).send({});
    expect(res.status).toBe(400);
  });
});

describe('revocation and re-issue', () => {
  it('re-issuing rotates the token: the old label stops, the new one works', async () => {
    const auth = await loginAsSeed();
    onGarden();
    const first = await issueSeedTag(auth);
    const second = await issueSeedTag(auth);
    expect(second.token).not.toBe(first.token);
    expect((await request(app).get(`/tag/${first.token}`)).status).toBe(404);
    expect((await request(app).get(`/tag/${second.token}`)).status).toBe(200);
    // Still one ACTIVE tag for the plant.
    const list = await request(app)
      .get(`/households/${seedHouseholdId}/plant-tags`)
      .set('Authorization', `Bearer ${auth}`);
    expect(list.body.tags).toHaveLength(1);
    expect(list.body.allowance.used).toBe(1);
  });

  it('revoking kills the label on the next scan; revoking again is a 404', async () => {
    const auth = await loginAsSeed();
    onGarden();
    const { token } = await issueSeedTag(auth);
    const revoke = await request(app)
      .delete(`/plants/${seedPlantId}/tag`)
      .set('Authorization', `Bearer ${auth}`);
    expect(revoke.status).toBe(204);
    expect((await request(app).get(`/tag/${token}`)).status).toBe(404);
    const again = await request(app)
      .delete(`/plants/${seedPlantId}/tag`)
      .set('Authorization', `Bearer ${auth}`);
    expect(again.status).toBe(404);
  });

  it('deleting the plant kills its tag', async () => {
    const auth = await loginAsSeed();
    onGarden();
    const { token } = await issueSeedTag(auth);
    await request(app).delete(`/plants/${seedPlantId}`).set('Authorization', `Bearer ${auth}`);
    expect((await request(app).get(`/tag/${token}`)).status).toBe(404);
    const list = await request(app)
      .get(`/households/${seedHouseholdId}/plant-tags`)
      .set('Authorization', `Bearer ${auth}`);
    expect(list.body.allowance.used).toBe(0);
  });

  it('a malformed or unknown token is one generic 404', async () => {
    const bad = await request(app).get('/tag/not-a-token');
    const unknown = await request(app).get(`/tag/${'f'.repeat(64)}`);
    expect(bad.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(bad.body.message).toBe(unknown.body.message);
  });
});

describe('household PIN', () => {
  it('is enforced on scan and complete, counts wrong tries per tag, and locks after five', async () => {
    const auth = await loginAsSeed();
    onGarden();
    const { token } = await issueSeedTag(auth);

    const set = await request(app)
      .put(`/households/${seedHouseholdId}/plant-tags/pin`)
      .set('Authorization', `Bearer ${auth}`)
      .send({ pin: '4321' });
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ pinEnabled: true });
    // Never stored in the clear.
    expect(JSON.stringify([...db.plantTagPins.values()])).not.toContain('4321');

    const noPin = await request(app).get(`/tag/${token}`);
    expect(noPin.status).toBe(401);
    expect(noPin.body.details).toEqual({ pinRequired: true, reason: 'required' });

    const right = await request(app).get(`/tag/${token}`).set('X-Tag-Pin', '4321');
    expect(right.status).toBe(200);

    const completeNoPin = await request(app)
      .post(`/tag/${token}/tasks/${seedTaskId}/complete`)
      .send({ displayName: 'Grandma' });
    expect(completeNoPin.status).toBe(401);

    for (let i = 0; i < 4; i++) {
      const wrong = await request(app).get(`/tag/${token}`).set('X-Tag-Pin', '0000');
      expect(wrong.status).toBe(401);
      expect(wrong.body.details.reason).toBe('wrong');
    }
    const fifth = await request(app).get(`/tag/${token}`).set('X-Tag-Pin', '0000');
    expect(fifth.status).toBe(423);
    expect(fifth.body.details.reason).toBe('locked');
    expect(typeof fifth.body.details.lockedUntil).toBe('string');
    // Even the right PIN is refused while locked.
    expect((await request(app).get(`/tag/${token}`).set('X-Tag-Pin', '4321')).status).toBe(423);

    // The lock is per TAG: re-issuing gives the household a working label now.
    const fresh = await issueSeedTag(auth);
    expect((await request(app).get(`/tag/${fresh.token}`).set('X-Tag-Pin', '4321')).status).toBe(
      200
    );

    // Clearing the PIN opens the tag again.
    const clear = await request(app)
      .put(`/households/${seedHouseholdId}/plant-tags/pin`)
      .set('Authorization', `Bearer ${auth}`)
      .send({ pin: null });
    expect(clear.body).toEqual({ pinEnabled: false });
    expect((await request(app).get(`/tag/${fresh.token}`)).status).toBe(200);
  });

  it('rejects a PIN that is not four digits', async () => {
    const auth = await loginAsSeed();
    const res = await request(app)
      .put(`/households/${seedHouseholdId}/plant-tags/pin`)
      .set('Authorization', `Bearer ${auth}`)
      .send({ pin: '12' });
    expect(res.status).toBe(400);
  });
});
