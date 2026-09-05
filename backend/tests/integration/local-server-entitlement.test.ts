/**
 * Entitlement parity between the mock dev server and the production handlers
 * (#476).
 *
 * PR #572 drew the line every paid surface turns on — `getEntitledPlan` for
 * what a household may START, `getEntitledPlanForIssuedGrant` for what an
 * already-issued grant KEEPS, with a lifetime purchase as a floor under both —
 * and converted the fourteen Lambda sites. It deliberately left
 * `src/local-server.ts`, which resolved the same decisions by indexing the
 * catalog (`PLANS[h?.planId ?? 'seedling']`) at twenty sites and so could see
 * neither the payment status nor a tier bought outright.
 *
 * This is the dev server, not production: nobody's card is charged here. It
 * matters for one reason, and the tests below are that reason — the
 * integration suite exercises the MOCK, so for as long as the mock disagreed
 * with the handlers, a test could pass against behaviour production does not
 * have. `route-parity.test.ts` exists because that divergence has bitten
 * before; it checks that every production route is registered here. These
 * check that the plan decisions behind a dozen of them answer the same way.
 *
 * Every surface gets a paired case — refused/narrowed while the card is
 * failing, served while it is good — so no conversion can pass by denying
 * everyone, plus the lifetime floor where the floor is what is at stake.
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
} from '../../src/local-server';

const SEED_EMAIL = 'test@example.com';
const SEED_PASSWORD = 'password123';

/** Statuses `entitlementIsCurrent` accepts. `undefined` = no row ever written. */
const ENTITLED_STATUSES = ['active', 'trialing', undefined] as const;
/** Statuses that entitle nothing. Stripe retries `past_due` for WEEKS. */
const DUNNING_STATUSES = ['past_due', 'unpaid', 'incomplete', 'incomplete_expired'] as const;

async function loginAsSeed(): Promise<string> {
  const res = await request(app)
    .post('/auth/login')
    .send({ email: SEED_EMAIL, password: SEED_PASSWORD });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function createConfirmedUser(email: string, name = 'Test Person'): Promise<string> {
  provisionLocalUserFixture({ email, password: 'password-123', name });
  const login = await request(app).post('/auth/login').send({ email, password: 'password-123' });
  expect(login.status).toBe(200);
  return login.body.accessToken as string;
}

/** Membership records are the auth source of truth in the mock. */
function seedMember(id: string, email: string): void {
  db.users.set(id, {
    id,
    email,
    password: 'password-123',
    name: `User ${id}`,
    confirmed: true,
    householdId: seedHouseholdId,
    householdRole: 'member',
    memberships: [
      { householdId: seedHouseholdId, role: 'member', joinedAt: new Date().toISOString() },
    ],
  } as never);
}

type Tier = 'seedling' | 'garden' | 'greenhouse';

/**
 * Put the seed household on a tier with a payment status and, optionally, a
 * tier bought outright. The three fields production's METADATA row carries;
 * the mock's webhook is a no-op (checkout answers 503 like the commercial
 * hold), so a test seeds them exactly as it seeds `planId`.
 */
function onPlan(planId: Tier | undefined, status?: string, lifetimePlanId?: Tier): void {
  const h = db.households.get(seedHouseholdId)!;
  h.planId = planId;
  h.subscriptionStatus = status;
  h.lifetimePlanId = lifetimePlanId;
}

/**
 * The shape the lifetime floor exists for: `customer.subscription.deleted`
 * writes `status: 'canceled'` and `applyStripeEvent` then restores `planId` to
 * the lifetime tier without rewriting the status. Resolved off the status
 * alone this is Seedling — silently destroying a purchase with no refund path.
 */
function onCancelledLifetime(tier: Tier = 'garden'): void {
  onPlan(tier, 'canceled', tier);
}

function inFuture(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function inPast(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

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

// ---------------------------------------------------------------------------
// STARTING — getEntitledPlan
// ---------------------------------------------------------------------------

describe('starting: what a household may begin (#476)', () => {
  describe('auto-handoff — PUT /households/:id/escalation', () => {
    // This route also carried a mock-only bug the conversion removes: it
    // tested `plan.householdToolkit`, but the flag lives at
    // `plan.features.householdToolkit` and `householdToolkit` is a field of
    // PlanSummary, not of Plan. local-server.ts is `@ts-nocheck`, so the
    // misreach read `undefined` and the route answered 402 on EVERY tier —
    // including Greenhouse — while the production handler answered 200.
    it('turns on for an entitled Garden household', async () => {
      const token = await loginAsSeed();
      for (const status of ENTITLED_STATUSES) {
        onPlan('garden', status);
        const res = await request(app)
          .put(`/households/${seedHouseholdId}/escalation`)
          .set(auth(token))
          .send({ escalateAfterDays: 5 });
        expect(res.status, `status=${String(status)}`).toBe(200);
        expect(res.body).toEqual({ escalateAfterDays: 5 });
      }
    });

    it('refuses while the card is failing, naming the free tier', async () => {
      const token = await loginAsSeed();
      for (const status of DUNNING_STATUSES) {
        onPlan('garden', status);
        const res = await request(app)
          .put(`/households/${seedHouseholdId}/escalation`)
          .set(auth(token))
          .send({ escalateAfterDays: 5 });
        expect(res.status, `status=${status}`).toBe(402);
        expect(res.body.message).toMatch(/Seedling plan does not include/);
      }
    });

    it('turns on for a household that bought Garden outright and cancelled a later subscription', async () => {
      const token = await loginAsSeed();
      onCancelledLifetime('garden');
      const res = await request(app)
        .put(`/households/${seedHouseholdId}/escalation`)
        .set(auth(token))
        .send({ escalateAfterDays: 5 });
      expect(res.status).toBe(200);
    });

    it('still refuses a household that never had the tier', async () => {
      const token = await loginAsSeed();
      onPlan('seedling', 'active');
      const res = await request(app)
        .put(`/households/${seedHouseholdId}/escalation`)
        .set(auth(token))
        .send({ escalateAfterDays: 5 });
      expect(res.status).toBe(402);
    });
  });

  describe('coverage — GET /households/:id/analytics/coverage', () => {
    it('serves an entitled Garden household and a lifetime owner; refuses one mid-dunning', async () => {
      const token = await loginAsSeed();
      const get = () =>
        request(app).get(`/households/${seedHouseholdId}/analytics/coverage`).set(auth(token));

      onPlan('garden', 'active');
      expect((await get()).status).toBe(200);

      onPlan('garden', 'past_due');
      const refused = await get();
      expect(refused.status).toBe(402);
      expect(refused.body.message).toMatch(/household toolkit/);

      onCancelledLifetime('garden');
      expect((await get()).status).toBe(200);
    });
  });

  describe('analytics window — GET /households/:id/analytics/daily', () => {
    it('narrows to the free tier while the card is failing and restores itself', async () => {
      const token = await loginAsSeed();
      const before = db.completions.size;
      const get = () =>
        request(app)
          .get(`/households/${seedHouseholdId}/analytics/daily?days=180`)
          .set(auth(token));

      onPlan('garden', 'active');
      const full = await get();
      expect(full.body.days).toBe(180);
      expect(full.body.historyLimitDays).toBeNull();

      onPlan('garden', 'past_due');
      const narrowed = await get();
      expect(narrowed.status).toBe(200);
      expect(narrowed.body.days).toBe(30);
      expect(narrowed.body.historyLimitDays).toBe(30);

      onCancelledLifetime('garden');
      expect((await get()).body.historyLimitDays).toBeNull();

      // Rows are never trimmed — only the window a request may ask for.
      expect(db.completions.size).toBe(before);
    });
  });

  describe('year in review — GET /households/:id/year-in-review', () => {
    it('windows the year while the card is failing', async () => {
      const token = await loginAsSeed();
      const year = new Date().getFullYear();
      const get = () =>
        request(app)
          .get(`/households/${seedHouseholdId}/year-in-review?year=${year}`)
          .set(auth(token));

      onPlan('garden', 'active');
      expect((await get()).body.historyLimitDays).toBeNull();

      onPlan('garden', 'past_due');
      const windowed = await get();
      expect(windowed.status).toBe(200);
      expect(windowed.body.historyLimitDays).toBe(30);
      expect(typeof windowed.body.windowStart).toBe('string');

      onCancelledLifetime('garden');
      expect((await get()).body.historyLimitDays).toBeNull();
    });
  });

  describe('sitter links — POST /households/:id/sitter-links', () => {
    it('mints a 30-day window on Garden, falls back to Seedling’s 7 while the card fails', async () => {
      const token = await loginAsSeed();
      const mint = (days: number) =>
        request(app)
          .post(`/households/${seedHouseholdId}/sitter-links`)
          .set(auth(token))
          .send({ expiresAt: inFuture(days) });

      onPlan('garden', 'active');
      expect((await mint(30)).status).toBe(201);

      onPlan('garden', 'past_due');
      const refused = await mint(30);
      expect(refused.status).toBe(402);
      expect(refused.body.message).toMatch(/up to 7 days/);

      onCancelledLifetime('garden');
      expect((await mint(30)).status).toBe(201);
    });
  });

  describe('caretaker seats — POST /households/:id/caretakers', () => {
    it('creates on Greenhouse, refuses mid-dunning, honours a Greenhouse lifetime floor', async () => {
      const token = await loginAsSeed();
      const create = () =>
        request(app)
          .post(`/households/${seedHouseholdId}/caretakers`)
          .set(auth(token))
          .send({ name: 'Dana', expiresAt: inFuture(14) });

      onPlan('greenhouse', 'active');
      expect((await create()).status).toBe(201);

      onPlan('greenhouse', 'past_due');
      const refused = await create();
      expect(refused.status).toBe(402);
      expect(refused.body.message).toMatch(/Greenhouse plan/);

      onCancelledLifetime('greenhouse');
      expect((await create()).status).toBe(201);
    });

    it('leaves list and revoke open on every tier, so no issued seat is trapped', async () => {
      const token = await loginAsSeed();
      onPlan('greenhouse', 'active');
      const seat = await request(app)
        .post(`/households/${seedHouseholdId}/caretakers`)
        .set(auth(token))
        .send({ name: 'Dana', expiresAt: inFuture(14) });
      expect(seat.status).toBe(201);

      onPlan('greenhouse', 'past_due');
      const list = await request(app)
        .get(`/households/${seedHouseholdId}/caretakers`)
        .set(auth(token));
      expect(list.status).toBe(200);
      const revoked = await request(app)
        .delete(`/households/${seedHouseholdId}/caretakers/${seat.body.id}`)
        .set(auth(token));
      expect(revoked.status).toBeLessThan(300);
    });
  });

  describe('kiosk — POST /households/:id/kiosk-link', () => {
    it('issues on Greenhouse and refuses mid-dunning', async () => {
      const token = await loginAsSeed();
      const issue = () =>
        request(app).post(`/households/${seedHouseholdId}/kiosk-link`).set(auth(token)).send({});

      onPlan('greenhouse', 'active');
      expect((await issue()).status).toBe(201);

      onPlan('greenhouse', 'past_due');
      const refused = await issue();
      expect(refused.status).toBe(402);
      expect(refused.body.message).toMatch(/Greenhouse plan/);

      onCancelledLifetime('greenhouse');
      expect((await issue()).status).toBe(201);
    });

    it('never gates the mounted display, which nobody in front of it can fix', async () => {
      const token = await loginAsSeed();
      onPlan('greenhouse', 'active');
      const issued = await request(app)
        .post(`/households/${seedHouseholdId}/kiosk-link`)
        .set(auth(token))
        .send({});
      expect(issued.status).toBe(201);

      onPlan('greenhouse', 'past_due');
      const display = await request(app).get(`/kiosk/${issued.body.token}`);
      expect(display.status).toBe(200);
    });
  });

  describe('API keys — POST /api-keys', () => {
    it('mints on Greenhouse and refuses mid-dunning, matching the middleware that gates USING one', async () => {
      const token = await loginAsSeed();
      const mint = (label: string) =>
        request(app).post('/api-keys').set(auth(token)).send({ label });

      onPlan('greenhouse', 'active');
      expect((await mint('one')).status).toBe(201);

      onPlan('greenhouse', 'past_due');
      const refused = await mint('two');
      expect(refused.status).toBe(402);
      expect(refused.body.message).toMatch(/Greenhouse plan/);

      onCancelledLifetime('greenhouse');
      expect((await mint('three')).status).toBe(201);
    });
  });

  describe('plant tags — POST /plants/:plantId/tag and the print sheet', () => {
    it('issues on Garden and refuses mid-dunning', async () => {
      const token = await loginAsSeed();
      const issue = () => request(app).post(`/plants/${seedPlantId}/tag`).set(auth(token)).send();

      onPlan('garden', 'active');
      expect((await issue()).status).toBe(201);

      onPlan('garden', 'past_due');
      const refused = await issue();
      expect(refused.status).toBe(402);
      expect(refused.body.message).toMatch(/Garden plan/);

      onCancelledLifetime('garden');
      expect((await issue()).status).toBe(201);
    });

    it('reports the allowance the issue route will actually enforce, and still lists issued tags', async () => {
      const token = await loginAsSeed();
      onPlan('garden', 'active');
      const issued = await request(app).post(`/plants/${seedPlantId}/tag`).set(auth(token)).send();
      expect(issued.status).toBe(201);

      const sheetOnPlan = await request(app)
        .get(`/households/${seedHouseholdId}/plant-tags`)
        .set(auth(token));
      expect(sheetOnPlan.body.allowance).toMatchObject({ enabled: true, max: 50 });
      expect(sheetOnPlan.body.planId).toBe('garden');

      onPlan('garden', 'past_due');
      const sheet = await request(app)
        .get(`/households/${seedHouseholdId}/plant-tags`)
        .set(auth(token));
      expect(sheet.status).toBe(200);
      // The sheet must not advertise a cap the write side would refuse.
      expect(sheet.body.allowance).toMatchObject({ enabled: false });
      expect(sheet.body.planId).toBe('seedling');
      // …but labels already printed are still reprintable, tokens and all.
      expect(sheet.body.tags).toHaveLength(1);
      expect(typeof sheet.body.tags[0].token).toBe('string');
    });

    it('never gates the public scan of a label already stuck in a pot', async () => {
      const token = await loginAsSeed();
      onPlan('garden', 'active');
      const issued = await request(app).post(`/plants/${seedPlantId}/tag`).set(auth(token)).send();
      expect(issued.status).toBe(201);

      onPlan('garden', 'past_due');
      const scan = await request(app).get(`/tag/${issued.body.token}`);
      expect(scan.status).toBe(200);
    });
  });

  describe('cross-home Today — GET /me/today', () => {
    it('serves an entitled Greenhouse member and refuses one mid-dunning', async () => {
      const token = await loginAsSeed();
      const get = () => request(app).get('/me/today').set(auth(token));

      onPlan('greenhouse', 'active');
      expect((await get()).status).toBe(200);

      onPlan('greenhouse', 'past_due');
      expect((await get()).status).toBe(402);

      onCancelledLifetime('greenhouse');
      expect((await get()).status).toBe(200);
    });
  });

  describe('away recap — GET /households/:id/away-recap', () => {
    it('follows the downgrade contract, not the sitter’s already-issued grant', async () => {
      const token = await loginAsSeed();
      const get = () =>
        request(app).get(`/households/${seedHouseholdId}/away-recap`).set(auth(token));

      // 404 = entitled, but no sitter window has ended yet. The distinction
      // that matters here is 402 vs not-402.
      onPlan('garden', 'active');
      expect((await get()).status).toBe(404);

      onPlan('garden', 'past_due');
      const refused = await get();
      expect(refused.status).toBe(402);
      expect(refused.body.message).toMatch(/Away Kit/);

      onCancelledLifetime('garden');
      expect((await get()).status).toBe(404);
    });
  });

  describe('member cap — POST /households/join/:inviteCode', () => {
    it('refuses the fourth hand while the card is failing and takes it once it is good', async () => {
      const admin = await loginAsSeed();
      seedMember('cap-fill-1', 'cap-fill-1@example.com');
      seedMember('cap-fill-2', 'cap-fill-2@example.com');

      onPlan('garden', 'past_due');
      const invite = await request(app)
        .post(`/households/${seedHouseholdId}/invites`)
        .set(auth(admin));
      expect(invite.status).toBe(201);

      const joiner = await createConfirmedUser('fourth@example.com');
      const refused = await request(app)
        .post(`/households/join/${invite.body.code}`)
        .set(auth(joiner));
      expect(refused.status).toBe(402);
      expect(refused.body.message).toMatch(/limited to 3 members/);

      onPlan('garden', 'active');
      const accepted = await request(app)
        .post(`/households/join/${invite.body.code}`)
        .set(auth(joiner));
      expect(accepted.status).toBe(200);
    });
  });

  describe('identification allowance — POST /plants/identify', () => {
    it('publishes the entitled tier’s monthly allowance, not the row’s', async () => {
      const token = await loginAsSeed();
      const identify = () =>
        request(app)
          .post('/plants/identify')
          .set(auth(token))
          .send({ image: 'a'.repeat(128) });

      onPlan('garden', 'active');
      expect((await identify()).body.usage.allowance).toBe(30);

      onPlan('garden', 'past_due');
      const dunning = await identify();
      expect(dunning.status).toBe(200);
      expect(dunning.body.usage.allowance).toBe(1);

      onCancelledLifetime('garden');
      expect((await identify()).body.usage.allowance).toBe(30);
    });
  });

  describe('meters — GET /billing/me', () => {
    it('publishes the caps that are ENFORCED while keeping planId truthful', async () => {
      const token = await loginAsSeed();
      const get = () => request(app).get('/billing/me').set(auth(token));

      onPlan('garden', 'active');
      const paid = await get();
      expect(paid.body.planId).toBe('garden');
      expect(paid.body.usage.maxPlants).toBe(200);

      onPlan('garden', 'past_due');
      const dunning = await get();
      expect(dunning.status).toBe(200);
      // The tier they are ON — truthful, and what production publishes.
      expect(dunning.body.planId).toBe('garden');
      expect(dunning.body.status).toBe('past_due');
      // The caps they may currently USE. Advertising 200 here while the next
      // POST /plants is refused at 20 is the mint-vs-use disagreement again.
      expect(dunning.body.usage.maxPlants).toBe(20);
      expect(dunning.body.usageDetail.maxPlants).toBe(20);

      onCancelledLifetime('garden');
      expect((await get()).body.usage.maxPlants).toBe(200);
    });
  });

  describe('plant cap — POST /plants', () => {
    it('refuses at the free tier’s cap while the card is failing', async () => {
      const token = await loginAsSeed();
      // Seedling allows 20 active plants; seed the household just over it so
      // the gate is reached without twenty round trips.
      const existing = [...db.plants.values()].filter((p) => p.householdId === seedHouseholdId);
      const template = existing[0]!;
      for (let i = existing.length; i < 20; i += 1) {
        const id = `cap-plant-${i}`;
        db.plants.set(id, { ...template, id, name: `Filler ${i}` });
      }

      onPlan('garden', 'past_due');
      const refused = await request(app)
        .post('/plants')
        .set(auth(token))
        .send({ name: 'One more' });
      expect(refused.status).toBe(402);
      expect(refused.body.message).toMatch(/limited to 20 plants/);

      onPlan('garden', 'active');
      const accepted = await request(app)
        .post('/plants')
        .set(auth(token))
        .send({ name: 'One more' });
      expect(accepted.status).toBe(201);
    });
  });

  describe('Move Day — POST /households/:id/move-day', () => {
    /** An outdoor space and a plant with a seasonal home, so the rules apply. */
    async function makeMoveDayApplicable(token: string): Promise<void> {
      const outside = await request(app)
        .post('/spaces')
        .set(auth(token))
        .send({ name: 'Summer patio', environment: 'outside' });
      expect(outside.status).toBe(201);
      const inside = await request(app)
        .post('/spaces')
        .set(auth(token))
        .send({ name: 'Winter window', environment: 'inside' });
      expect(inside.status).toBe(201);
      const updated = await request(app)
        .put(`/plants/${seedPlantId}`)
        .set(auth(token))
        .send({ summerSpaceId: outside.body.id, winterSpaceId: inside.body.id });
      expect(updated.status).toBe(200);
    }

    const fire = (token: string) =>
      request(app).post(`/households/${seedHouseholdId}/move-day?season=winter`).set(auth(token));

    it('fires a new season for an entitled household', async () => {
      const token = await loginAsSeed();
      await makeMoveDayApplicable(token);
      onPlan('garden', 'active');
      const res = await fire(token);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ready');
      expect(res.body.list.items.length).toBeGreaterThan(0);
    });

    it('goes quiet rather than ready while the card is failing, leaving the season UNCLAIMED', async () => {
      const token = await loginAsSeed();
      await makeMoveDayApplicable(token);
      onPlan('garden', 'past_due');

      const dunning = await fire(token);
      // 'quiet', not 'locked': the row still says Garden, so the household is
      // not told the feature is gone — it simply may not claim the season.
      expect(dunning.body).toEqual({ status: 'quiet' });

      // …and because nothing was claimed, the very next load after the card is
      // fixed produces the list. A 'ready' here would have burnt the 180-day
      // re-fire gap for a household that was never shown the list.
      onPlan('garden', 'active');
      const recovered = await fire(token);
      expect(recovered.body.status).toBe('ready');
    });

    it('locks for a tier that never had it', async () => {
      const token = await loginAsSeed();
      await makeMoveDayApplicable(token);
      onPlan('seedling', 'active');
      expect((await fire(token)).body).toEqual({ status: 'locked' });
    });
  });
});

// ---------------------------------------------------------------------------
// CONTINUING — getEntitledPlanForIssuedGrant
// ---------------------------------------------------------------------------

describe('continuing: what an already-issued grant keeps (#476)', () => {
  /** A live link issued while the household was entitled. */
  async function issueLink(token: string): Promise<{ id: string; token: string }> {
    onPlan('garden', 'active');
    const res = await request(app)
      .post(`/households/${seedHouseholdId}/sitter-links`)
      .set(auth(token))
      .send({ expiresAt: inFuture(21), label: 'Our plants' });
    expect(res.status).toBe(201);
    return { id: res.body.id, token: res.body.token };
  }

  it('keeps the sitter view and its briefAvailable flag agreeing while the card fails', async () => {
    const owner = await loginAsSeed();
    const link = await issueLink(owner);

    onPlan('garden', 'past_due');
    const view = await request(app).get(`/sitter/${link.token}`);
    expect(view.status).toBe(200);
    // The sitter standing in the kitchen is not the buyer and cannot enter a
    // payment method. If this flag went false, the page would still offer the
    // control and the brief below would 404 — or the reverse.
    expect(view.body.briefAvailable).toBe(true);
  });

  it('keeps the handoff brief for a sitter mid-trip', async () => {
    const owner = await loginAsSeed();
    const link = await issueLink(owner);

    for (const status of DUNNING_STATUSES) {
      onPlan('garden', status);
      const brief = await request(app).get(`/sitter/${link.token}/brief`);
      expect(brief.status, `status=${status}`).toBe(200);
      expect(Array.isArray(brief.body.plants)).toBe(true);
    }
  });

  it('keeps photo-back open for a sitter mid-trip', async () => {
    const owner = await loginAsSeed();
    const link = await issueLink(owner);

    onPlan('garden', 'past_due');
    const photos = await request(app).get(`/sitter/${link.token}/photos`);
    expect(photos.status).toBe(200);
    expect(photos.body.enabled).toBe(true);
  });

  it('still refuses a sitter link that is expired or revoked, whatever the plan says', async () => {
    const owner = await loginAsSeed();
    const link = await issueLink(owner);
    // The leniency is bounded by the link's own window, which is validated
    // BEFORE entitlement is consulted — that is what stops it being a loophole.
    db.sitterLinks.get(link.token)!.expiresAt = inPast(1);

    onPlan('garden', 'active');
    expect((await request(app).get(`/sitter/${link.token}/brief`)).status).toBe(404);
    expect((await request(app).get(`/sitter/${link.token}/photos`)).status).toBe(404);
  });

  it('falls to the free tier once Stripe finally resets planId', async () => {
    const owner = await loginAsSeed();
    const link = await issueLink(owner);
    // customer.subscription.deleted: dunning gave up and the row is Seedling.
    onPlan('seedling', 'canceled');
    expect((await request(app).get(`/sitter/${link.token}/brief`)).status).toBe(404);
    expect((await request(app).get(`/sitter/${link.token}`)).body.briefAvailable).toBe(false);
  });

  it('keeps a Move Day season that was already claimed', async () => {
    const token = await loginAsSeed();
    const outside = await request(app)
      .post('/spaces')
      .set(auth(token))
      .send({ name: 'Summer patio', environment: 'outside' });
    const inside = await request(app)
      .post('/spaces')
      .set(auth(token))
      .send({ name: 'Winter window', environment: 'inside' });
    await request(app)
      .put(`/plants/${seedPlantId}`)
      .set(auth(token))
      .send({ summerSpaceId: outside.body.id, winterSpaceId: inside.body.id });

    onPlan('garden', 'active');
    const claimed = await request(app)
      .post(`/households/${seedHouseholdId}/move-day?season=winter`)
      .set(auth(token));
    expect(claimed.body.status).toBe('ready');

    // Card fails on day 3 of the 14-day card window. The tasks are already in
    // the household's list and half the plants are already inside; a
    // half-finished frost move is worse than either whole outcome.
    onPlan('garden', 'past_due');
    const still = await request(app)
      .post(`/households/${seedHouseholdId}/move-day?season=winter`)
      .set(auth(token));
    expect(still.body.status).toBe('ready');
    expect(still.body.list.items).toEqual(claimed.body.list.items);
  });
});
