/**
 * "Ask family to do it" (ADR 0024) end to end against the mock dev server,
 * which mirrors services/askFamily.ts: the occurrence goes up for grabs
 * through the SAME escalated state auto-handoff uses, the ask is recorded on
 * the row with its note, the household activity feed carries it, the reach is
 * reported honestly, and the refusals all land on their status codes.
 */
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
const HELPER_ID = '22222222-2222-4222-8222-222222222222';

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post('/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

function seedMember(id: string, email: string): void {
  db.users.set(id, {
    id,
    email,
    password: 'password-123',
    name: `User ${id}`,
    confirmed: true,
    householdId: seedHouseholdId,
    householdRole: 'member',
    memberships: [{ householdId: seedHouseholdId, role: 'member', joinedAt: '2026-01-02' }],
  } as never);
}

const originalLog = console.log;
beforeEach(() => {
  resetDb();
  console.log = () => {};
  seedMember(HELPER_ID, 'helper@example.com');
});
afterEach(() => {
  console.log = originalLog;
});

describe('POST /tasks/:id/ask', () => {
  it('puts the occurrence up for grabs, records who asked and why, and names who was told', async () => {
    const token = await login(SEED_EMAIL, SEED_PASSWORD);
    const task = db.tasks.get(seedTaskId)!;
    task.assignedTo = seedUserId;
    task.assignedToName = 'Test User';
    task.assignmentSource = null;

    const res = await request(app)
      .post(`/tasks/${seedTaskId}/ask`)
      .set('Authorization', `Bearer ${token}`)
      .send({ note: '  I am  travelling until Sunday  ' });

    expect(res.status).toBe(200);
    // The escalated state, reached through the human door.
    expect(res.body.task).toMatchObject({
      assignedTo: null,
      assignedToName: null,
      assignmentSource: null,
      helpAskedBy: seedUserId,
      helpAskedByName: 'Test User',
      helpAskedForDue: task.nextDue,
      escalatedForDue: task.nextDue,
      escalatedFrom: seedUserId,
    });
    // Whitespace collapsed by the shared pure normaliser.
    expect(res.body.note).toBe('I am travelling until Sunday');
    expect(res.body.recipients).toEqual([{ userId: HELPER_ID, name: `User ${HELPER_ID}` }]);
    expect(res.body.skipped).toEqual([]);
    // The mock never sends, and says so rather than counting recipients as
    // deliveries.
    expect(res.body.delivered).toBe(0);
    expect(JSON.stringify(res.body.recipients)).not.toContain('@example.com');
  });

  it('records the ask, with its note, in the household activity feed', async () => {
    const token = await login(SEED_EMAIL, SEED_PASSWORD);
    await request(app)
      .post(`/tasks/${seedTaskId}/ask`)
      .set('Authorization', `Bearer ${token}`)
      .send({ note: 'back on Monday' });

    const activity = await request(app)
      .get(`/households/${seedHouseholdId}/activity`)
      .set('Authorization', `Bearer ${token}`);
    expect(activity.status).toBe(200);
    const asked = activity.body.find((e: { type: string }) => e.type === 'task.help_requested');
    expect(asked).toMatchObject({
      actorName: 'Test User',
      payload: {
        taskId: seedTaskId,
        plantId: seedPlantId,
        note: 'back on Monday',
        notified: 1,
      },
    });
  });

  it('reports an EMPTY reach honestly when the only housemate is away', async () => {
    const token = await login(SEED_EMAIL, SEED_PASSWORD);
    db.vacations.set(`${seedHouseholdId}|${HELPER_ID}`, {
      householdId: seedHouseholdId,
      userId: HELPER_ID,
      coveredBy: seedUserId,
      coveredByName: 'Test User',
      startDate: new Date(Date.now() - 86_400_000).toISOString(),
      endDate: new Date(Date.now() + 86_400_000).toISOString(),
      createdBy: seedUserId,
      createdAt: new Date().toISOString(),
    } as never);

    const res = await request(app)
      .post(`/tasks/${seedTaskId}/ask`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.recipients).toEqual([]);
    expect(res.body.skipped).toEqual([
      { userId: HELPER_ID, name: `User ${HELPER_ID}`, reason: 'away' },
    ]);
    // The task still went up for grabs — the ask is not undone by nobody
    // hearing it, and the client is told exactly that.
    expect(res.body.task.helpAskedForDue).toBe(res.body.task.nextDue);
    expect(res.body.note).toBeNull();
  });

  it('refuses a second ask about the same occurrence with 409', async () => {
    const token = await login(SEED_EMAIL, SEED_PASSWORD);
    await request(app)
      .post(`/tasks/${seedTaskId}/ask`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    const second = await request(app)
      .post(`/tasks/${seedTaskId}/ask`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(second.status).toBe(409);
  });

  it('refuses a repeat inside the 24-hour window with 429 and the retry date', async () => {
    const token = await login(SEED_EMAIL, SEED_PASSWORD);
    await request(app)
      .post(`/tasks/${seedTaskId}/ask`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    // A completion would advance nextDue and re-arm the occurrence; the
    // per-member daily marker still holds.
    const task = db.tasks.get(seedTaskId)!;
    task.nextDue = new Date(Date.now() + 7 * 86_400_000).toISOString();

    const again = await request(app)
      .post(`/tasks/${seedTaskId}/ask`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(again.status).toBe(429);
    expect(again.body.details.nextAllowedAt).toEqual(expect.any(String));
  });

  it('refuses to give away another member’s explicit claim with 403', async () => {
    const token = await login(SEED_EMAIL, SEED_PASSWORD);
    const task = db.tasks.get(seedTaskId)!;
    task.assignedTo = HELPER_ID;
    task.assignedToName = 'Helper';
    task.assignmentSource = null;

    const res = await request(app)
      .post(`/tasks/${seedTaskId}/ask`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it('refuses a stale expectedNextDue with 409, and an unknown task with 404', async () => {
    const token = await login(SEED_EMAIL, SEED_PASSWORD);
    const stale = await request(app)
      .post(`/tasks/${seedTaskId}/ask`)
      .set('Authorization', `Bearer ${token}`)
      .send({ expectedNextDue: '2020-01-01T00:00:00.000Z' });
    expect(stale.status).toBe(409);

    const missing = await request(app)
      .post('/tasks/44444444-4444-4444-8444-444444444444/ask')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(missing.status).toBe(404);
  });

  it('lets the household claim the asked task back, which closes the ask', async () => {
    const token = await login(SEED_EMAIL, SEED_PASSWORD);
    await request(app)
      .post(`/tasks/${seedTaskId}/ask`)
      .set('Authorization', `Bearer ${token}`)
      .send({ note: 'away' });

    const helperToken = await login('helper@example.com', 'password-123');
    const claimed = await request(app)
      .post(`/tasks/${seedTaskId}/claim`)
      .set('Authorization', `Bearer ${helperToken}`);

    expect(claimed.status).toBe(200);
    expect(claimed.body.assignedTo).toBe(HELPER_ID);
    // There is no "cancel my ask": the ask is derived from
    // `helpAskedForDue === nextDue AND nobody holds it`, so claiming ends it
    // while the record of who asked survives on the row.
    expect(claimed.body.helpAskedBy).toBe(seedUserId);
  });
});
