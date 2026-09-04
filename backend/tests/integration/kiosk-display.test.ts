/**
 * End-to-end flows for the kiosk (wall display) link against the mock dev
 * server, which mirrors the production handlers (see local-server.ts contract
 * note). Covers what the unit tests can't: the full issue → public view →
 * public complete → revoke lifecycle, the Greenhouse gate, the fact that
 * re-issuing kills the previous token, the no-PII guarantee of the public
 * payload, the cross-household guard, and that the secret token is returned
 * exactly once.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, db, resetDb, seedHouseholdId, seedTaskId } from '../../src/local-server';

const SEED_EMAIL = 'test@example.com';
const SEED_PASSWORD = 'password123';

async function loginAsSeed(): Promise<string> {
  const res = await request(app)
    .post('/auth/login')
    .send({ email: SEED_EMAIL, password: SEED_PASSWORD });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

/** The kiosk is Greenhouse-only, so every happy path starts here. */
function upgradeSeedHouseholdToGreenhouse(): void {
  const household = db.households.get(seedHouseholdId);
  expect(household).toBeDefined();
  household!.planId = 'greenhouse';
}

async function issueKiosk(auth: string, body: Record<string, unknown> = {}) {
  return request(app)
    .post(`/households/${seedHouseholdId}/kiosk-link`)
    .set('Authorization', `Bearer ${auth}`)
    .send(body);
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

describe('kiosk link issue (authed, Greenhouse-gated)', () => {
  it('refuses a household that is not on Greenhouse', async () => {
    const auth = await loginAsSeed();
    const res = await issueKiosk(auth);
    expect(res.status).toBe(402);
    expect(res.body.message).toMatch(/Greenhouse/);
  });

  it('issues the token + URL exactly once, defaulting to a five-minute poll', async () => {
    const auth = await loginAsSeed();
    upgradeSeedHouseholdToGreenhouse();

    const res = await issueKiosk(auth);
    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.url).toContain(`/kiosk/${res.body.token}`);
    // The ~$0.01/household/month default. See services/kioskService.ts.
    expect(res.body.pollIntervalSeconds).toBe(300);

    // The token never comes back again — a screenshot of settings is not a
    // credential.
    const read = await request(app)
      .get(`/households/${seedHouseholdId}/kiosk-link`)
      .set('Authorization', `Bearer ${auth}`);
    expect(read.status).toBe(200);
    expect(read.body.link.id).toBe(res.body.id);
    expect(read.body.link).not.toHaveProperty('token');
  });

  it('honours a configured poll interval and rejects one outside the band', async () => {
    const auth = await loginAsSeed();
    upgradeSeedHouseholdToGreenhouse();

    const ok = await issueKiosk(auth, { pollIntervalSeconds: 900 });
    expect(ok.status).toBe(201);
    expect(ok.body.pollIntervalSeconds).toBe(900);

    const tooFast = await issueKiosk(auth, { pollIntervalSeconds: 5 });
    expect(tooFast.status).toBe(400);
  });

  it('re-issuing revokes the previous token in the same call', async () => {
    const auth = await loginAsSeed();
    upgradeSeedHouseholdToGreenhouse();

    const first = await issueKiosk(auth);
    const second = await issueKiosk(auth);
    expect(second.body.token).not.toBe(first.body.token);

    // The photographed screen stops working the moment a new code is printed.
    expect((await request(app).get(`/kiosk/${first.body.token}`)).status).toBe(404);
    expect((await request(app).get(`/kiosk/${second.body.token}`)).status).toBe(200);
  });

  it('reports "no kiosk link" as an explicit null, not an empty body', async () => {
    const auth = await loginAsSeed();
    const res = await request(app)
      .get(`/households/${seedHouseholdId}/kiosk-link`)
      .set('Authorization', `Bearer ${auth}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ link: null });
  });
});

describe('kiosk public view', () => {
  it('returns today’s tasks and the poll interval with no auth at all', async () => {
    const auth = await loginAsSeed();
    upgradeSeedHouseholdToGreenhouse();
    const issued = await issueKiosk(auth);

    const res = await request(app).get(`/kiosk/${issued.body.token}`);
    expect(res.status).toBe(200);
    expect(res.body.pollIntervalSeconds).toBe(300);
    expect(Array.isArray(res.body.tasks)).toBe(true);
  });

  it('exposes no household, member, or private-note data', async () => {
    const auth = await loginAsSeed();
    upgradeSeedHouseholdToGreenhouse();
    const issued = await issueKiosk(auth);

    const res = await request(app).get(`/kiosk/${issued.body.token}`);
    expect(Object.keys(res.body).sort()).toEqual(['pollIntervalSeconds', 'tasks']);
    for (const task of res.body.tasks) {
      expect(Object.keys(task).sort()).toEqual([
        'dueDate',
        'overdue',
        'placementNote',
        'plantName',
        'spaceName',
        'taskId',
        'taskType',
      ]);
    }
    // Belt and braces: the whole payload must not mention the household id or
    // the seed member's email.
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(seedHouseholdId);
    expect(serialized).not.toContain(SEED_EMAIL);
  });

  it('404s for a malformed, unknown, or revoked token with one message', async () => {
    const auth = await loginAsSeed();
    upgradeSeedHouseholdToGreenhouse();
    const issued = await issueKiosk(auth);

    const malformed = await request(app).get('/kiosk/not-a-token');
    const unknown = await request(app).get(`/kiosk/${'b'.repeat(64)}`);
    expect(malformed.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(malformed.body.message).toBe(unknown.body.message);

    await request(app)
      .delete(`/households/${seedHouseholdId}/kiosk-link`)
      .set('Authorization', `Bearer ${auth}`)
      .expect(204);

    const revoked = await request(app).get(`/kiosk/${issued.body.token}`);
    expect(revoked.status).toBe(404);
    expect(revoked.body.message).toBe(malformed.body.message);
  });
});

describe('kiosk public completion', () => {
  it('completes a task and attributes it to the display, not a member', async () => {
    const auth = await loginAsSeed();
    upgradeSeedHouseholdToGreenhouse();
    const issued = await issueKiosk(auth);

    const res = await request(app)
      .post(`/kiosk/${issued.body.token}/tasks/${seedTaskId}/complete`)
      .send({});
    expect(res.status).toBe(200);

    const completion = [...db.completions.values()].find((c) => c.taskId === seedTaskId);
    expect(completion?.completedBy).toBe(`kiosk:${issued.body.id}`);
    expect(completion?.completedByName).toBe('the kiosk display');

    const event = [...db.activity.values()].find((e) => e.type === 'task.completed');
    // The household can see the wall screen in its feed — which is how an
    // unexpected completion from a leaked token gets noticed.
    expect(event?.actorId).toBe(`kiosk:${issued.body.id}`);
    expect((event?.payload as { viaKiosk?: boolean }).viaKiosk).toBe(true);
  });

  it('refuses a task from another household', async () => {
    const auth = await loginAsSeed();
    upgradeSeedHouseholdToGreenhouse();
    const issued = await issueKiosk(auth);

    // Re-home the seed task so the token's household no longer owns it.
    const task = db.tasks.get(seedTaskId);
    expect(task).toBeDefined();
    task!.householdId = 'some-other-household';

    const res = await request(app)
      .post(`/kiosk/${issued.body.token}/tasks/${seedTaskId}/complete`)
      .send({});
    expect(res.status).toBe(404);
  });

  it('stops working the instant the link is revoked', async () => {
    const auth = await loginAsSeed();
    upgradeSeedHouseholdToGreenhouse();
    const issued = await issueKiosk(auth);

    await request(app)
      .delete(`/households/${seedHouseholdId}/kiosk-link`)
      .set('Authorization', `Bearer ${auth}`)
      .expect(204);

    const res = await request(app)
      .post(`/kiosk/${issued.body.token}/tasks/${seedTaskId}/complete`)
      .send({});
    expect(res.status).toBe(404);
  });

  it('does not roll the schedule twice when the same occurrence is tapped twice', async () => {
    const auth = await loginAsSeed();
    upgradeSeedHouseholdToGreenhouse();
    const issued = await issueKiosk(auth);

    const view = await request(app).get(`/kiosk/${issued.body.token}`);
    const target = view.body.tasks.find((t: { taskId: string }) => t.taskId === seedTaskId) as {
      taskId: string;
      dueDate: string;
    };
    expect(target).toBeDefined();

    const first = await request(app)
      .post(`/kiosk/${issued.body.token}/tasks/${seedTaskId}/complete`)
      .send({ expectedNextDue: target.dueDate });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post(`/kiosk/${issued.body.token}/tasks/${seedTaskId}/complete`)
      .send({ expectedNextDue: target.dueDate });
    expect(second.status).toBe(200);

    const completions = [...db.completions.values()].filter((c) => c.taskId === seedTaskId);
    expect(completions).toHaveLength(1);
  });
});

describe('kiosk revoke', () => {
  it('is NOT plan-gated — a downgraded household can still turn the screen off', async () => {
    const auth = await loginAsSeed();
    upgradeSeedHouseholdToGreenhouse();
    await issueKiosk(auth);

    // Downgrade, then revoke. Turning a wall display off is a safety control.
    db.households.get(seedHouseholdId)!.planId = 'seedling';

    await request(app)
      .delete(`/households/${seedHouseholdId}/kiosk-link`)
      .set('Authorization', `Bearer ${auth}`)
      .expect(204);
  });

  it('404s when there is nothing live to revoke', async () => {
    const auth = await loginAsSeed();
    const res = await request(app)
      .delete(`/households/${seedHouseholdId}/kiosk-link`)
      .set('Authorization', `Bearer ${auth}`);
    expect(res.status).toBe(404);
  });
});
