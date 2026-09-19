/**
 * The dev server's mirror of `POST /households/{id}/import-archive` (#669).
 *
 * The mock runs the SAME pure module as production
 * (models/householdArchive.ts) and differs only in storage, so this checks the
 * wiring rather than re-proving the rules: the route answers through the
 * mock's auth, a real mock export restores into a new household, a second
 * commit adds nothing, and a household with data is refused. The production
 * behaviour itself is proven in archive-import.test.ts.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  app,
  db,
  provisionLocalUserFixture,
  resetDb,
  seedHouseholdId,
} from '../../src/local-server';

async function login(email: string, password: string): Promise<Record<string, string>> {
  const res = await request(app).post('/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken as string}` };
}

describe('local-server: POST /households/:id/import-archive', () => {
  beforeEach(() => {
    resetDb();
  });

  it('restores the seed household export into a new household, once', async () => {
    const seed = await login('test@example.com', 'password123');
    const exported = await request(app).get('/me/export').set(seed);
    expect(exported.status).toBe(200);
    const archive = JSON.parse(exported.text) as {
      households: Array<{ id: string; plants: unknown[]; tasks: unknown[] }>;
    };
    const section = archive.households.find((h) => h.id === seedHouseholdId)!;
    // Negative control: there is something to restore.
    expect(section.plants.length).toBeGreaterThan(0);

    provisionLocalUserFixture({
      email: 'restorer@example.invalid',
      password: 'password-123',
      name: 'Rae Restorer',
    });
    const restorer = await login('restorer@example.invalid', 'password-123');
    const created = await request(app).post('/households').set(restorer).send({ name: 'New home' });
    expect(created.status).toBe(201);
    const targetId = created.body.id as string;
    const headers = { ...restorer, 'X-Household-Id': targetId };
    const route = `/households/${targetId}/import-archive`;
    const body = { sourceHouseholdId: seedHouseholdId, archive };

    const preview = await request(app)
      .post(route)
      .set(headers)
      .send({ mode: 'preview', ...body });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ target: { state: 'empty' }, canImport: true });
    expect(preview.body.counts.plants).toBe(section.plants.length);

    const commit = await request(app)
      .post(route)
      .set(headers)
      .send({ mode: 'commit', confirmDigest: preview.body.digest, ...body });
    expect(commit.status).toBe(200);
    expect(commit.body).toMatchObject({ status: 'complete' });
    const restored = [...db.plants.values()].filter((p) => p.householdId === targetId);
    expect(restored).toHaveLength(section.plants.length);

    const again = await request(app)
      .post(route)
      .set(headers)
      .send({ mode: 'commit', confirmDigest: preview.body.digest, ...body });
    expect(again.body).toMatchObject({ status: 'already_imported' });
    expect([...db.plants.values()].filter((p) => p.householdId === targetId)).toHaveLength(
      section.plants.length
    );

    // The seed household has data, so it is never a target.
    const intoSeed = await request(app)
      .post(`/households/${seedHouseholdId}/import-archive`)
      .set(seed)
      .send({ mode: 'commit', confirmDigest: preview.body.digest, ...body });
    expect(intoSeed.status).toBe(409);
  });

  it('refuses a newer archive version with its code', async () => {
    const seed = await login('test@example.com', 'password123');
    const res = await request(app)
      .post(`/households/${seedHouseholdId}/import-archive`)
      .set(seed)
      .send({
        mode: 'preview',
        archive: { format: 'family-greenhouse-export', version: 3, households: [] },
      });
    expect(res.status).toBe(400);
    expect(res.body.details.code).toBe('unsupported_version');
  });
});
