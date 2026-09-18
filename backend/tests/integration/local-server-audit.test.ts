/**
 * The dev server's mirror of the household audit log (#675). The Lambda side
 * is covered by household-audit.test.ts; this keeps the mock the frontend and
 * the e2e suite run against from drifting: same route, same admin gate, same
 * stored shape (it builds rows with the production `buildAuditItem`), and the
 * same refusal to store a credential.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, db, resetDb, seedHouseholdId, seedUserId } from '../../src/local-server';

async function loginAsSeed(): Promise<string> {
  const res = await request(app)
    .post('/auth/login')
    .send({ email: 'test@example.com', password: 'password123' });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
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

describe('GET /households/:id/audit (dev server)', () => {
  it('records an invite and a sitter link without their secrets, and pages newest first', async () => {
    const auth = await loginAsSeed();
    const invite = await request(app)
      .post(`/households/${seedHouseholdId}/invites`)
      .set('Authorization', `Bearer ${auth}`);
    expect(invite.status).toBe(201);
    const sitter = await request(app)
      .post(`/households/${seedHouseholdId}/sitter-links`)
      .set('Authorization', `Bearer ${auth}`)
      .send({ expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString() });
    expect(sitter.status).toBe(201);

    const first = await request(app)
      .get(`/households/${seedHouseholdId}/audit?limit=1`)
      .set('Authorization', `Bearer ${auth}`);
    expect(first.status).toBe(200);
    expect(first.body.retentionDays).toBe(30);
    expect(first.body.items).toHaveLength(1);
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const second = await request(app)
      .get(`/households/${seedHouseholdId}/audit`)
      .query({ limit: 1, cursor: first.body.nextCursor })
      .set('Authorization', `Bearer ${auth}`);
    expect(second.status).toBe(200);
    expect(second.body.nextCursor).toBeNull();

    const items = [...first.body.items, ...second.body.items];
    expect(items.map((i: { kind: string }) => i.kind).sort()).toEqual([
      'invite.created',
      'sitter_link.created',
    ]);
    for (const item of items) {
      expect(item.actor).toEqual({ type: 'member', name: expect.any(String) });
    }

    // The negative control: both secrets were really issued, and neither is
    // in what the log stored or served.
    const secrets = [invite.body.code as string, sitter.body.token as string];
    for (const secret of secrets) expect(secret.length).toBeGreaterThanOrEqual(32);
    const stored = JSON.stringify([...db.audit.values()]);
    const served = JSON.stringify(items);
    for (const secret of secrets) {
      expect(stored).not.toContain(secret);
      expect(served).not.toContain(secret);
    }
    expect(stored).not.toContain(seedUserId);
  });

  it('refuses a non-admin', async () => {
    const auth = await loginAsSeed();
    const seed = db.users.get(seedUserId)!;
    seed.householdRole = 'member';
    for (const m of seed.memberships) m.role = 'member';
    const res = await request(app)
      .get(`/households/${seedHouseholdId}/audit`)
      .set('Authorization', `Bearer ${auth}`);
    expect(res.status).toBe(403);
  });
});
