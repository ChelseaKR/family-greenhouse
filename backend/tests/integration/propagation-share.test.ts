/**
 * End-to-end flows for propagation lineage + cutting shares against the mock
 * dev server (which mirrors the production handlers — see local-server.ts
 * contract note). Covers what the unit tests can't: snapshot immunity to
 * source edits, multi-redeem, the public (unauthenticated) preview, and the
 * plan-cap 402 on accept.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, db, resetDb, seedHouseholdId, seedPlantId } from '../../src/local-server';

const SEED_EMAIL = 'test@example.com';
const SEED_PASSWORD = 'password123';

async function loginAsSeed(): Promise<string> {
  const res = await request(app)
    .post('/auth/login')
    .send({ email: SEED_EMAIL, password: SEED_PASSWORD });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

/** Signup → confirm → login → create an own household; returns the token. */
async function createUserWithHousehold(email: string, householdName: string): Promise<string> {
  const signup = await request(app)
    .post('/auth/signup')
    .send({ email, password: 'password-123', name: 'Neighbor' });
  expect(signup.status).toBe(201);
  await request(app).post('/auth/confirm').send({ email, code: '123456' });
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

describe('propagation lineage', () => {
  it('creates a cutting linked to its parent and surfaces lineage on both detail views', async () => {
    const token = await loginAsSeed();

    const create = await request(app)
      .post('/plants')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Baby Monstera', parentPlantId: seedPlantId });
    expect(create.status).toBe(201);
    expect(create.body.parentPlantId).toBe(seedPlantId);
    const childId = create.body.id as string;

    // Child view: parent link present.
    const child = await request(app)
      .get(`/plants/${childId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(child.status).toBe(200);
    expect(child.body.lineage.parent).toMatchObject({ id: seedPlantId, name: 'Monstera' });

    // Parent view: child listed.
    const parent = await request(app)
      .get(`/plants/${seedPlantId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(parent.status).toBe(200);
    expect(parent.body.lineage.parent).toBeUndefined();
    expect(parent.body.lineage.children).toEqual([
      expect.objectContaining({ id: childId, name: 'Baby Monstera', status: 'active' }),
    ]);

    // Propagated creates record the specific activity type.
    const activityTypes = [...db.activity.values()].map((e) => e.type);
    expect(activityTypes).toContain('plant.propagated');
  });

  it('keeps died cuttings in the parent lineage (propagation history)', async () => {
    const token = await loginAsSeed();
    const create = await request(app)
      .post('/plants')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Doomed Cutting', parentPlantId: seedPlantId });
    const childId = create.body.id as string;
    await request(app)
      .put(`/plants/${childId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'died' });

    const parent = await request(app)
      .get(`/plants/${seedPlantId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(parent.body.lineage.children).toEqual([
      expect.objectContaining({ id: childId, status: 'died' }),
    ]);
  });

  it('rejects a nonexistent parent and a parent from another household', async () => {
    const token = await loginAsSeed();
    const bogus = await request(app)
      .post('/plants')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Orphan', parentPlantId: '99999999-9999-4999-8999-999999999999' });
    expect(bogus.status).toBe(400);

    // A plant in someone ELSE's household can't be claimed as parent.
    const otherToken = await createUserWithHousehold('other@example.com', 'Other House');
    const theirs = await request(app)
      .post('/plants')
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ name: 'Their Fern' });
    const cross = await request(app)
      .post('/plants')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Stolen Cutting', parentPlantId: theirs.body.id });
    expect(cross.status).toBe(400);
  });

  it('rejects self-parenting on update', async () => {
    const token = await loginAsSeed();
    const res = await request(app)
      .put(`/plants/${seedPlantId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parentPlantId: seedPlantId });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/own parent/);
  });

  it("rejects a 2-hop cycle (A -> B, then B set as A's parent)", async () => {
    const token = await loginAsSeed();
    const b = await request(app)
      .post('/plants')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Cutting B', parentPlantId: seedPlantId });
    expect(b.status).toBe(201);

    // seedPlantId (A) is already B's ancestor; making B the parent of A
    // would close a 2-node cycle.
    const res = await request(app)
      .put(`/plants/${seedPlantId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parentPlantId: b.body.id });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/circular/);

    // The cycle must not have been written.
    const unchanged = await request(app)
      .get(`/plants/${seedPlantId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(unchanged.body.parentPlantId).toBeNull();
  });

  it("rejects a 3-hop cycle (A -> B -> C, then C set as A's parent)", async () => {
    const token = await loginAsSeed();
    const b = await request(app)
      .post('/plants')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Cutting B', parentPlantId: seedPlantId });
    expect(b.status).toBe(201);
    const c = await request(app)
      .post('/plants')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Cutting C', parentPlantId: b.body.id });
    expect(c.status).toBe(201);

    // A -> B -> C already; C is A's descendant, so C can't become A's parent
    // without the ancestor walk (a 1-hop check alone would miss this).
    const res = await request(app)
      .put(`/plants/${seedPlantId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parentPlantId: c.body.id });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/circular/);
  });
});

describe('cutting shares', () => {
  it('share → public preview → accept lands a copy in the acceptor household', async () => {
    const token = await loginAsSeed();

    const share = await request(app)
      .post(`/plants/${seedPlantId}/share`)
      .set('Authorization', `Bearer ${token}`);
    expect(share.status).toBe(201);
    expect(share.body.code).toMatch(/^[0-9a-f]{32}$/);
    expect(share.body.url).toContain(`/shared/${share.body.code}`);

    // Preview is PUBLIC — no Authorization header at all.
    const preview = await request(app).get(`/plants/shared/${share.body.code}`);
    expect(preview.status).toBe(200);
    expect(preview.body.plant).toMatchObject({
      name: 'Monstera',
      species: 'Monstera deliciosa',
      tags: ['tropical'],
    });
    expect(preview.body.householdName).toBe('Test Household');

    // Accept as a different user into THEIR household.
    const otherToken = await createUserWithHousehold('friend@example.com', 'Friend House');
    const accept = await request(app)
      .post(`/plants/shared/${share.body.code}/accept`)
      .set('Authorization', `Bearer ${otherToken}`);
    expect(accept.status).toBe(201);
    expect(accept.body.householdId).not.toBe(seedHouseholdId);
    expect(accept.body.name).toBe('Monstera');
    expect(accept.body.notes).toMatch(/^Cutting from Test Household/);
    // Image is NOT copied (S3 object belongs to the source household).
    expect(accept.body.imageUrl).toBeNull();

    const acceptedTypes = [...db.activity.values()]
      .filter((e) => e.householdId === accept.body.householdId)
      .map((e) => e.type);
    expect(acceptedTypes).toContain('plant.shared_accepted');
  });

  it('snapshot is immune to later edits of the source plant', async () => {
    const token = await loginAsSeed();
    const share = await request(app)
      .post(`/plants/${seedPlantId}/share`)
      .set('Authorization', `Bearer ${token}`);

    // Mutate the source after sharing.
    await request(app)
      .put(`/plants/${seedPlantId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Renamed!', notes: 'totally different now' });

    const preview = await request(app).get(`/plants/shared/${share.body.code}`);
    expect(preview.status).toBe(200);
    expect(preview.body.plant.name).toBe('Monstera'); // as shared, not as edited
    expect(preview.body.plant.notes).toBe('Needs indirect light');
  });

  it('survives deletion of the source plant (still previewable + acceptable)', async () => {
    const token = await loginAsSeed();
    const share = await request(app)
      .post(`/plants/${seedPlantId}/share`)
      .set('Authorization', `Bearer ${token}`);
    await request(app).delete(`/plants/${seedPlantId}`).set('Authorization', `Bearer ${token}`);

    const preview = await request(app).get(`/plants/shared/${share.body.code}`);
    expect(preview.status).toBe(200);
    expect(preview.body.plant.name).toBe('Monstera');
  });

  it('404s for unknown and expired codes', async () => {
    const unknown = await request(app).get(`/plants/shared/${'f'.repeat(32)}`);
    expect(unknown.status).toBe(404);

    const token = await loginAsSeed();
    const share = await request(app)
      .post(`/plants/${seedPlantId}/share`)
      .set('Authorization', `Bearer ${token}`);
    // Force-expire the row (mirrors a row DDB TTL hasn't swept yet).
    const row = db.shares.get(share.body.code)!;
    row.expiresAt = new Date(Date.now() - 1000).toISOString();

    const expired = await request(app).get(`/plants/shared/${share.body.code}`);
    expect(expired.status).toBe(404);
    const acceptExpired = await request(app)
      .post(`/plants/shared/${share.body.code}/accept`)
      .set('Authorization', `Bearer ${token}`);
    expect(acceptExpired.status).toBe(404);
  });

  it('is multi-redeem within the TTL, and accepting into the source household is allowed', async () => {
    const token = await loginAsSeed();
    const share = await request(app)
      .post(`/plants/${seedPlantId}/share`)
      .set('Authorization', `Bearer ${token}`);

    // Redeem twice — a cutting card, not a one-time security token.
    const first = await request(app)
      .post(`/plants/shared/${share.body.code}/accept`)
      .set('Authorization', `Bearer ${token}`);
    const second = await request(app)
      .post(`/plants/shared/${share.body.code}/accept`)
      .set('Authorization', `Bearer ${token}`);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    // Both copies landed in the (same, source) household — harmless dupes.
    expect(first.body.householdId).toBe(seedHouseholdId);
    expect(second.body.householdId).toBe(seedHouseholdId);
    expect(first.body.id).not.toBe(second.body.id);
  });

  it('accept enforces the acceptor plan cap with 402', async () => {
    const token = await loginAsSeed();
    const share = await request(app)
      .post(`/plants/${seedPlantId}/share`)
      .set('Authorization', `Bearer ${token}`);

    const otherToken = await createUserWithHousehold('capped@example.com', 'Capped House');
    // Fill the Seedling plan's 10-plant cap.
    for (let i = 0; i < 10; i++) {
      const created = await request(app)
        .post('/plants')
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ name: `Filler ${i}` });
      expect(created.status).toBe(201);
    }

    const accept = await request(app)
      .post(`/plants/shared/${share.body.code}/accept`)
      .set('Authorization', `Bearer ${otherToken}`);
    expect(accept.status).toBe(402);
    expect(accept.body.message).toMatch(/limited to 10 plants/);
  });

  it('requires auth to share and to accept (but not to preview)', async () => {
    const noAuthShare = await request(app).post(`/plants/${seedPlantId}/share`);
    expect(noAuthShare.status).toBe(401);

    const token = await loginAsSeed();
    const share = await request(app)
      .post(`/plants/${seedPlantId}/share`)
      .set('Authorization', `Bearer ${token}`);
    const noAuthAccept = await request(app).post(`/plants/shared/${share.body.code}/accept`);
    expect(noAuthAccept.status).toBe(401);
  });

  it('cannot share a plant from another household (404)', async () => {
    const otherToken = await createUserWithHousehold('sneak@example.com', 'Sneak House');
    const res = await request(app)
      .post(`/plants/${seedPlantId}/share`)
      .set('Authorization', `Bearer ${otherToken}`);
    expect(res.status).toBe(404);
  });
});
