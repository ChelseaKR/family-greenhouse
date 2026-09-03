import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

// The billing handler is a thin wrapper over services/billing.ts; mock the
// whole module so we can stub the Stripe side-effects without setting up a
// real Stripe client. Note we keep the real `ALL_PLANS`/`planSummary` exports
// from a partial import — listPlans iterates over them. Mocking everything to
// `vi.fn()` would leave ALL_PLANS undefined and crash that handler.
vi.mock('../../../src/services/billing.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/services/billing.js')>(
    '../../../src/services/billing.js'
  );
  return {
    ...actual,
    getHouseholdSubscription: vi.fn(),
    createCheckoutSession: vi.fn(),
    createPortalSession: vi.fn(),
    applyStripeEvent: vi.fn(),
    getStripe: vi.fn(),
  };
});

// The METADATA counter read behind GET /billing/me's usage block — mocked so
// tests never touch DynamoDB. Defaults are re-seeded in beforeEach (the
// global resetAllMocks wipes implementations).
vi.mock('../../../src/services/householdUsage.js', () => ({
  getHouseholdCounters: vi.fn(),
}));
import { getHouseholdCounters } from '../../../src/services/householdUsage.js';

// The identification top-up pack (ADR 0019): its credit balance read and its
// checkout are separate services, mocked the same way as the counters.
vi.mock('../../../src/services/identifyCredits.js', () => ({
  getCreditBalance: vi.fn(),
}));
import { getCreditBalance } from '../../../src/services/identifyCredits.js';
vi.mock('../../../src/services/identifyTopUp.js', () => ({
  createIdentifyTopUpCheckoutSession: vi.fn(),
  TOP_UP_NOT_CONFIGURED: 'TOP_UP_NOT_CONFIGURED',
}));
import { createIdentifyTopUpCheckoutSession } from '../../../src/services/identifyTopUp.js';

function buildEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    path: '/',
    pathParameters: null,
    queryStringParameters: null,
    requestContext: {
      authorizer: {
        claims: {
          sub: 'user-1',
          email: 'test@example.com',
          'custom:household_id': 'hh-1',
          'custom:household_role': 'admin',
        },
      },
      identity: { sourceIp: '127.0.0.1' },
    } as APIGatewayProxyEvent['requestContext'],
    resource: '/',
    stageVariables: null,
    ...overrides,
  };
}

const ctx = {} as Context;

describe('billing handler', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    process.env.PAYMENTS_ENABLED = '1';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    process.env.FRONTEND_URL = 'https://test.familygreenhouse.net';
    // authMiddleware validates the claim household against the membership
    // table; pre-warm the cache so the un-mocked householdService is never
    // consulted. Tests for non-admin callers re-warm with role 'member'.
    const { __resetMembershipCacheForTests } = await import('../../../src/middleware/auth.js');
    __resetMembershipCacheForTests();
    const { setCachedMembership } = await import('../../../src/utils/membershipCache.js');
    setCachedMembership('user-1', 'hh-1', 'admin');
    // Counters default to "nothing recorded" — individual tests override.
    vi.mocked(getHouseholdCounters).mockResolvedValue({ plantCount: 0, memberCount: 0 });
    // No packs bought is a real zero; individual tests override.
    vi.mocked(getCreditBalance).mockResolvedValue({ remaining: 0, expiresAt: null });
    delete process.env.STRIPE_PRICE_ID_IDENTIFY_TOP_UP;
  });

  afterEach(() => {
    delete process.env.PAYMENTS_ENABLED;
    delete process.env.STRIPE_PRICE_ID_IDENTIFY_TOP_UP;
  });

  describe('listPlans', () => {
    it('publishes a cacheable priced catalog once both commercial gates are open', async () => {
      // This suite sets PAYMENTS_ENABLED=1 and the repository hold is lifted,
      // so both gates are open and the catalog may carry amounts.
      const { listPlans } = await import('../../../src/handlers/billing/handler.js');
      const res = (await listPlans(
        buildEvent({ httpMethod: 'GET' }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(200);
      expect(res.headers?.['Cache-Control']).toMatch(/public.*max-age=300/);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({
        paymentsAvailable: true,
        commercialHold: { active: false, effectiveDate: '2026-09-01' },
      });
      expect(body.plans).toHaveLength(3);
      expect(body.plans.map((p: { id: string }) => p.id).sort()).toEqual([
        'garden',
        'greenhouse',
        'seedling',
      ]);

      const byId = Object.fromEntries(body.plans.map((p: { id: string }) => [p.id, p])) as Record<
        string,
        Record<string, unknown>
      >;
      // `null` (not absent) is the explicit "not sold at this cadence" signal
      // the client relies on to render "not available" rather than $0. Since
      // 2026-09-02 that is also how a WITHDRAWN cadence publishes: annual on
      // both paid tiers and Garden lifetime stay on the catalog for existing
      // subscribers but are no longer offered, so only monthly carries an
      // amount here.
      expect(byId.seedling).toMatchObject({
        monthlyPrice: 0,
        annualPrice: null,
        lifetimePrice: null,
      });
      expect(byId.garden).toMatchObject({
        monthlyPrice: 4.99,
        annualPrice: null,
        lifetimePrice: null,
      });
      expect(byId.greenhouse).toMatchObject({
        monthlyPrice: 9.99,
        annualPrice: null,
        lifetimePrice: null,
      });
      // The top-up offer rides on the same gates: payments are on so the
      // amount is published, but with no Stripe price configured it is NOT
      // available — the client offers nothing the API would refuse.
      expect(body.identifyTopUp).toEqual({
        available: false,
        credits: 20,
        validityDays: 365,
        priceUsd: 1.99,
      });
    });

    it('publishes the top-up pack as available once a Stripe price is configured', async () => {
      process.env.STRIPE_PRICE_ID_IDENTIFY_TOP_UP = 'price_topup';
      const { listPlans } = await import('../../../src/handlers/billing/handler.js');
      const res = (await listPlans(
        buildEvent({ httpMethod: 'GET' }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;
      expect(JSON.parse(res.body).identifyTopUp).toEqual({
        available: true,
        credits: 20,
        validityDays: 365,
        priceUsd: 1.99,
      });
    });

    it('withholds every price when the runtime gate alone is shut', async () => {
      // Lifting the repository hold is necessary but not sufficient. With no
      // PAYMENTS_ENABLED the catalog must publish no amounts at all — the
      // state production stays in until its own gate is opened.
      delete process.env.PAYMENTS_ENABLED;
      const { listPlans } = await import('../../../src/handlers/billing/handler.js');
      const res = (await listPlans(
        buildEvent({ httpMethod: 'GET' }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      const body = JSON.parse(res.body);
      expect(body).toMatchObject({
        paymentsAvailable: false,
        commercialHold: { active: false, effectiveDate: '2026-09-01' },
      });
      expect(body.plans).toHaveLength(3);
      for (const plan of body.plans) {
        expect(plan).not.toHaveProperty('monthlyPrice');
        expect(plan).not.toHaveProperty('annualPrice');
        expect(plan).not.toHaveProperty('lifetimePrice');
      }
    });
  });

  describe('getCurrentSubscription', () => {
    it('returns the household subscription from billing service', async () => {
      const billing = await import('../../../src/services/billing.js');
      const { getCurrentSubscription } = await import('../../../src/handlers/billing/handler.js');

      vi.mocked(billing.getHouseholdSubscription).mockResolvedValueOnce({
        planId: 'garden',
        stripeCustomerId: 'cus_1',
        status: 'active',
      });

      const res = (await getCurrentSubscription(
        buildEvent({ httpMethod: 'GET' }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        planId: 'garden',
        stripeCustomerId: 'cus_1',
        identifyCredits: { remaining: 0, expiresAt: null },
      });
      expect(billing.getHouseholdSubscription).toHaveBeenCalledWith('hh-1');
      expect(getCreditBalance).toHaveBeenCalledWith('hh-1');
    });

    it('publishes the top-up credit balance, and an UNREADABLE balance as null rather than 0', async () => {
      const billing = await import('../../../src/services/billing.js');
      const { getCurrentSubscription } = await import('../../../src/handlers/billing/handler.js');
      vi.mocked(billing.getHouseholdSubscription).mockResolvedValue({ planId: 'garden' });

      vi.mocked(getCreditBalance).mockResolvedValueOnce({
        remaining: 17,
        expiresAt: '2027-09-03T12:00:00.000Z',
      });
      let res = (await getCurrentSubscription(
        buildEvent({ httpMethod: 'GET' }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;
      expect(JSON.parse(res.body).identifyCredits).toEqual({
        remaining: 17,
        expiresAt: '2027-09-03T12:00:00.000Z',
      });

      vi.mocked(getCreditBalance).mockResolvedValueOnce(null);
      res = (await getCurrentSubscription(
        buildEvent({ httpMethod: 'GET' }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('identifyCredits');
      expect(body.identifyCredits).toBeNull();
    });

    it('includes matching legacy usage and nullable-capable detail when both counters are known', async () => {
      const billing = await import('../../../src/services/billing.js');
      const { getCurrentSubscription } = await import('../../../src/handlers/billing/handler.js');
      vi.mocked(billing.getHouseholdSubscription).mockResolvedValueOnce({ planId: 'garden' });
      vi.mocked(getHouseholdCounters).mockResolvedValueOnce({ plantCount: 42, memberCount: 3 });

      const res = (await getCurrentSubscription(
        buildEvent({ httpMethod: 'GET' }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // Garden: 200 plants, unlimited members (`null`, ADR 0014).
      const expectedUsage = {
        plantCount: 42,
        maxPlants: 200,
        memberCount: 3,
        maxMembers: null,
      };
      expect(body.usage).toEqual(expectedUsage);
      expect(body.usageDetail).toEqual(expectedUsage);
      expect(getHouseholdCounters).toHaveBeenCalledWith('hh-1');
    });

    it('reports over-limit usage verbatim after a downgrade (caps come from the NEW plan)', async () => {
      const billing = await import('../../../src/services/billing.js');
      const { getCurrentSubscription } = await import('../../../src/handlers/billing/handler.js');
      // Household downgraded to seedling while holding 25 plants / 8 members.
      vi.mocked(billing.getHouseholdSubscription).mockResolvedValueOnce({ planId: 'seedling' });
      vi.mocked(getHouseholdCounters).mockResolvedValueOnce({ plantCount: 25, memberCount: 8 });

      const res = (await getCurrentSubscription(
        buildEvent({ httpMethod: 'GET' }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      const body = JSON.parse(res.body);
      const usage = body.usage;
      expect(usage).toEqual({ plantCount: 25, maxPlants: 20, memberCount: 8, maxMembers: 3 });
      expect(body.usageDetail).toEqual(usage);
      expect(usage.plantCount).toBeGreaterThan(usage.maxPlants);
      expect(usage.memberCount).toBeGreaterThan(usage.maxMembers);
    });

    it('omits legacy usage and preserves partial knowledge in usageDetail', async () => {
      const billing = await import('../../../src/services/billing.js');
      const { getCurrentSubscription } = await import('../../../src/handlers/billing/handler.js');
      vi.mocked(billing.getHouseholdSubscription).mockResolvedValueOnce({ planId: 'seedling' });
      vi.mocked(getHouseholdCounters).mockResolvedValueOnce({
        plantCount: 25,
        memberCount: null,
      });

      const res = (await getCurrentSubscription(
        buildEvent({ httpMethod: 'GET' }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).not.toHaveProperty('usage');
      expect(body.usageDetail).toEqual({
        plantCount: 25,
        maxPlants: 20,
        memberCount: null,
        maxMembers: 3,
      });
    });

    it('returns 403 when the caller has no household claim', async () => {
      const { getCurrentSubscription } = await import('../../../src/handlers/billing/handler.js');
      const res = (await getCurrentSubscription(
        buildEvent({
          httpMethod: 'GET',
          requestContext: {
            authorizer: { claims: { sub: 'user-1', email: 'test@example.com' } },
          } as APIGatewayProxyEvent['requestContext'],
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(403);
      expect(res.body).toMatch(/household/i);
    });
  });

  describe('checkout', () => {
    it('returns 503 when payment collection has not been explicitly enabled', async () => {
      const billing = await import('../../../src/services/billing.js');
      const { checkout } = await import('../../../src/handlers/billing/handler.js');
      process.env.PAYMENTS_ENABLED = '0';
      const error = new Error('Payment activity is disabled') as Error & { code?: string };
      error.code = 'PAYMENTS_DISABLED';
      vi.mocked(billing.createCheckoutSession).mockRejectedValueOnce(error);

      const res = (await checkout(
        buildEvent({
          body: JSON.stringify({ planId: 'garden' }),
          headers: { 'content-type': 'application/json' },
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body).message).toMatch(/payments are currently paused/i);
    });

    it('creates a Stripe checkout session and returns the URL', async () => {
      const billing = await import('../../../src/services/billing.js');
      const { checkout } = await import('../../../src/handlers/billing/handler.js');

      vi.mocked(billing.createCheckoutSession).mockResolvedValueOnce({
        url: 'https://checkout.stripe.test/session_xyz',
      });

      const res = (await checkout(
        buildEvent({
          body: JSON.stringify({ planId: 'garden' }),
          headers: { 'content-type': 'application/json' },
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ url: 'https://checkout.stripe.test/session_xyz' });
      expect(billing.createCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({
          householdId: 'hh-1',
          customerEmail: 'test@example.com',
          planId: 'garden',
          // Omitting `interval` defaults to a monthly subscription.
          interval: 'month',
          successUrl: expect.stringContaining('/settings/billing?status=success'),
          cancelUrl: expect.stringContaining('/settings/billing?status=cancel'),
        })
      );
    });

    it('still sells the monthly cadence on both paid tiers', async () => {
      const billing = await import('../../../src/services/billing.js');
      const { checkout } = await import('../../../src/handlers/billing/handler.js');

      for (const planId of ['garden', 'greenhouse'] as const) {
        vi.mocked(billing.createCheckoutSession).mockResolvedValueOnce({
          url: `https://checkout.stripe.test/${planId}-monthly`,
        });
        const res = (await checkout(
          buildEvent({
            body: JSON.stringify({ planId, interval: 'month' }),
            headers: { 'content-type': 'application/json' },
          }),
          ctx,
          () => {}
        )) as APIGatewayProxyResult;

        expect(res.statusCode, planId).toBe(200);
        expect(billing.createCheckoutSession).toHaveBeenCalledWith(
          expect.objectContaining({ planId, interval: 'month' })
        );
      }
    });

    // Withdrawn from sale 2026-09-02: Garden annual, Greenhouse annual, and
    // Garden lifetime (`withdrawnIntervals` in models/plans.ts). A body that a
    // live button once sent — or that anyone can craft — must be refused
    // before the service is even called. The message has to be clear about
    // what happened, and clear that existing subscribers are not affected.
    it.each([
      ['garden', 'year'],
      ['garden', 'lifetime'],
      ['greenhouse', 'year'],
    ] as const)(
      'refuses the withdrawn %s/%s cadence with a 400 before touching the service',
      async (planId, interval) => {
        const billing = await import('../../../src/services/billing.js');
        const { checkout } = await import('../../../src/handlers/billing/handler.js');

        const res = (await checkout(
          buildEvent({
            body: JSON.stringify({ planId, interval }),
            headers: { 'content-type': 'application/json' },
          }),
          ctx,
          () => {}
        )) as APIGatewayProxyResult;

        expect(res.statusCode).toBe(400);
        expect(res.body).toMatch(/no longer offered/i);
        expect(res.body).toMatch(/existing subscriptions are unaffected/i);
        expect(billing.createCheckoutSession).not.toHaveBeenCalled();
      }
    );

    it('maps the service-level INTERVAL_WITHDRAWN guard to the same 400, for any path around the schema', async () => {
      // Defence in depth: if a caller ever reaches createCheckoutSession with
      // a withdrawn cadence (a future route, a schema regression), the
      // service refuses too, and that refusal must not surface as the
      // generic "Stripe checkout failed" 502.
      const billing = await import('../../../src/services/billing.js');
      const { checkout } = await import('../../../src/handlers/billing/handler.js');
      vi.mocked(billing.createCheckoutSession).mockRejectedValueOnce(
        new Error("INTERVAL_WITHDRAWN: Garden is no longer sold at the 'year' cadence.")
      );

      const res = (await checkout(
        buildEvent({
          body: JSON.stringify({ planId: 'garden', interval: 'month' }),
          headers: { 'content-type': 'application/json' },
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toMatch(/no longer offered/i);
      expect(JSON.parse(res.body).message).not.toMatch(/stripe checkout failed/i);
    });

    it('scopes the client checkout attempt id to the household', async () => {
      const billing = await import('../../../src/services/billing.js');
      const { checkout } = await import('../../../src/handlers/billing/handler.js');
      const checkoutAttemptId = '123e4567-e89b-42d3-a456-426614174000';
      vi.mocked(billing.createCheckoutSession).mockResolvedValueOnce({
        url: 'https://checkout.stripe.test/idempotent',
      });

      const res = (await checkout(
        buildEvent({
          body: JSON.stringify({ planId: 'garden', checkoutAttemptId }),
          headers: { 'content-type': 'application/json' },
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(200);
      expect(billing.createCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: `checkout:hh-1:${checkoutAttemptId}` })
      );
    });

    it('refuses a stale client that still sends the Garden lifetime body, even with a valid attempt id', async () => {
      // The exact request the "Buy Garden for life" button sent before the
      // withdrawal. A cached bundle can still send it; it must not buy.
      const billing = await import('../../../src/services/billing.js');
      const { checkout } = await import('../../../src/handlers/billing/handler.js');

      const res = (await checkout(
        buildEvent({
          body: JSON.stringify({
            planId: 'garden',
            interval: 'lifetime',
            checkoutAttemptId: '123e4567-e89b-42d3-a456-426614174000',
          }),
          headers: { 'content-type': 'application/json' },
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(400);
      expect(billing.createCheckoutSession).not.toHaveBeenCalled();
    });

    it('rejects interval=lifetime for a non-Garden tier (Greenhouse) with a 400', async () => {
      const billing = await import('../../../src/services/billing.js');
      const { checkout } = await import('../../../src/handlers/billing/handler.js');

      const res = (await checkout(
        buildEvent({
          body: JSON.stringify({ planId: 'greenhouse', interval: 'lifetime' }),
          headers: { 'content-type': 'application/json' },
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(400);
      // The lifetime refine must reject before any Stripe call is attempted.
      expect(billing.createCheckoutSession).not.toHaveBeenCalled();
    });

    it('rejects an unknown billing interval at the validation layer', async () => {
      const { checkout } = await import('../../../src/handlers/billing/handler.js');
      const res = (await checkout(
        buildEvent({
          body: JSON.stringify({ planId: 'garden', interval: 'weekly' }),
          headers: { 'content-type': 'application/json' },
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(400);
    });

    it('returns 403 when the caller is a non-admin household member', async () => {
      const { setCachedMembership } = await import('../../../src/utils/membershipCache.js');
      setCachedMembership('user-1', 'hh-1', 'member');
      const { checkout } = await import('../../../src/handlers/billing/handler.js');
      const res = (await checkout(
        buildEvent({
          body: JSON.stringify({ planId: 'garden' }),
          headers: { 'content-type': 'application/json' },
          requestContext: {
            authorizer: {
              claims: {
                sub: 'user-1',
                email: 'test@example.com',
                'custom:household_id': 'hh-1',
                'custom:household_role': 'member',
              },
            },
          } as APIGatewayProxyEvent['requestContext'],
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(403);
      expect(res.body).toMatch(/admin/i);
    });

    it('rejects invalid plan ids at the validation layer', async () => {
      const { checkout } = await import('../../../src/handlers/billing/handler.js');
      const res = (await checkout(
        buildEvent({
          body: JSON.stringify({ planId: 'enterprise' }),
          headers: { 'content-type': 'application/json' },
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(400);
    });

    it('translates upstream Stripe errors to an intentional 502 with a safe JSON body', async () => {
      const billing = await import('../../../src/services/billing.js');
      const { checkout } = await import('../../../src/handlers/billing/handler.js');

      vi.mocked(billing.createCheckoutSession).mockRejectedValueOnce(
        new Error('upstream down: sk_live_secret hint')
      );

      const res = (await checkout(
        buildEvent({
          body: JSON.stringify({ planId: 'greenhouse' }),
          headers: { 'content-type': 'application/json' },
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      // New error contract: intentional 502s (expose: true) keep their safe
      // message as JSON {message}; the raw SDK error never reaches clients.
      expect(res.statusCode).toBe(502);
      expect(res.headers?.['Content-Type']).toBe('application/json');
      const body = JSON.parse(res.body);
      expect(body.message).toMatch(/stripe checkout failed/i);
      expect(res.body).not.toContain('sk_live_secret');
    });

    it('maps the already-subscribed guard to a clear 409 pointing at the portal, not the generic 502', async () => {
      const billing = await import('../../../src/services/billing.js');
      const { checkout } = await import('../../../src/handlers/billing/handler.js');

      vi.mocked(billing.createCheckoutSession).mockRejectedValueOnce(
        new Error('ALREADY_SUBSCRIBED: This household already has an active subscription.')
      );

      const res = (await checkout(
        buildEvent({
          body: JSON.stringify({ planId: 'greenhouse' }),
          headers: { 'content-type': 'application/json' },
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.message).toMatch(/manage subscription/i);
    });
  });

  describe('topUpCheckout (ADR 0019)', () => {
    const post = (body: unknown = {}) =>
      buildEvent({
        body: body === null ? null : JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      });

    it('fails CLOSED with a 400 TOP_UP_NOT_CONFIGURED when no price is configured — nothing reaches Stripe', async () => {
      const { topUpCheckout } = await import('../../../src/handlers/billing/handler.js');
      const res = (await topUpCheckout(post(), ctx, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.message).toMatch(/not available in this environment/i);
      expect(body.details).toEqual({ code: 'TOP_UP_NOT_CONFIGURED' });
      expect(createIdentifyTopUpCheckoutSession).not.toHaveBeenCalled();
    });

    it('opens the one-time checkout and returns the URL, scoping the attempt id to the household', async () => {
      process.env.STRIPE_PRICE_ID_IDENTIFY_TOP_UP = 'price_topup';
      const { topUpCheckout } = await import('../../../src/handlers/billing/handler.js');
      vi.mocked(createIdentifyTopUpCheckoutSession).mockResolvedValueOnce({
        url: 'https://checkout.stripe.test/topup',
      });
      const res = (await topUpCheckout(
        post({ checkoutAttemptId: '0f6ba7f4-2bc7-4d0e-9c3a-3f9a4e1b8c11' }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ url: 'https://checkout.stripe.test/topup' });
      expect(createIdentifyTopUpCheckoutSession).toHaveBeenCalledWith({
        householdId: 'hh-1',
        customerEmail: 'test@example.com',
        successUrl: expect.stringContaining(
          '/settings/billing?status=success&purchase=identify-top-up'
        ),
        cancelUrl: expect.stringContaining('/settings/billing?status=cancel'),
        idempotencyKey: 'top-up:hh-1:0f6ba7f4-2bc7-4d0e-9c3a-3f9a4e1b8c11',
      });
    });

    it('accepts an empty or missing body (there is one pack; nothing to choose)', async () => {
      process.env.STRIPE_PRICE_ID_IDENTIFY_TOP_UP = 'price_topup';
      const { topUpCheckout } = await import('../../../src/handlers/billing/handler.js');
      vi.mocked(createIdentifyTopUpCheckoutSession).mockResolvedValue({ url: 'https://s' });
      for (const body of [{}, null]) {
        const res = (await topUpCheckout(post(body), ctx, () => {})) as APIGatewayProxyResult;
        expect(res.statusCode, JSON.stringify(body)).toBe(200);
      }
      expect(createIdentifyTopUpCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: undefined })
      );
    });

    it('rejects a malformed attempt id at the validation layer', async () => {
      process.env.STRIPE_PRICE_ID_IDENTIFY_TOP_UP = 'price_topup';
      const { topUpCheckout } = await import('../../../src/handlers/billing/handler.js');
      const res = (await topUpCheckout(
        post({ checkoutAttemptId: 'not-a-uuid' }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(400);
      expect(createIdentifyTopUpCheckoutSession).not.toHaveBeenCalled();
    });

    it('returns 403 for a non-admin member — buying is admin-only like every purchase', async () => {
      process.env.STRIPE_PRICE_ID_IDENTIFY_TOP_UP = 'price_topup';
      const { setCachedMembership } = await import('../../../src/utils/membershipCache.js');
      setCachedMembership('user-1', 'hh-1', 'member');
      const { topUpCheckout } = await import('../../../src/handlers/billing/handler.js');
      const res = (await topUpCheckout(
        buildEvent({
          body: JSON.stringify({}),
          headers: { 'content-type': 'application/json' },
          requestContext: {
            authorizer: {
              claims: {
                sub: 'user-1',
                email: 'test@example.com',
                'custom:household_id': 'hh-1',
                'custom:household_role': 'member',
              },
            },
            identity: { sourceIp: '127.0.0.1' },
          } as APIGatewayProxyEvent['requestContext'],
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(403);
      expect(createIdentifyTopUpCheckoutSession).not.toHaveBeenCalled();
    });

    it('returns 503 while payment activity is paused', async () => {
      process.env.STRIPE_PRICE_ID_IDENTIFY_TOP_UP = 'price_topup';
      const { topUpCheckout } = await import('../../../src/handlers/billing/handler.js');
      const error = new Error('Payment activity is disabled') as Error & { code?: string };
      error.code = 'PAYMENTS_DISABLED';
      vi.mocked(createIdentifyTopUpCheckoutSession).mockRejectedValueOnce(error);
      const res = (await topUpCheckout(post(), ctx, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body).message).toMatch(/payments are currently paused/i);
    });

    it('maps the service-level TOP_UP_NOT_CONFIGURED guard to the same 400, for any path around the handler check', async () => {
      process.env.STRIPE_PRICE_ID_IDENTIFY_TOP_UP = 'price_topup';
      const { topUpCheckout } = await import('../../../src/handlers/billing/handler.js');
      vi.mocked(createIdentifyTopUpCheckoutSession).mockRejectedValueOnce(
        new Error('TOP_UP_NOT_CONFIGURED: STRIPE_PRICE_ID_IDENTIFY_TOP_UP is not set')
      );
      const res = (await topUpCheckout(post(), ctx, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).details).toEqual({ code: 'TOP_UP_NOT_CONFIGURED' });
    });

    it('translates an upstream Stripe failure to an intentional, safe 502', async () => {
      process.env.STRIPE_PRICE_ID_IDENTIFY_TOP_UP = 'price_topup';
      const { topUpCheckout } = await import('../../../src/handlers/billing/handler.js');
      vi.mocked(createIdentifyTopUpCheckoutSession).mockRejectedValueOnce(
        new Error('StripeConnectionError: secret internals')
      );
      const res = (await topUpCheckout(post(), ctx, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(502);
      expect(JSON.parse(res.body).message).toMatch(/Stripe checkout failed/);
      expect(res.body).not.toMatch(/secret internals/);
    });
  });

  describe('portal', () => {
    it('returns 503 when billing-portal access is paused', async () => {
      const billing = await import('../../../src/services/billing.js');
      const { portal } = await import('../../../src/handlers/billing/handler.js');
      const error = new Error('Payment activity is disabled') as Error & { code?: string };
      error.code = 'PAYMENTS_DISABLED';
      vi.mocked(billing.createPortalSession).mockRejectedValueOnce(error);

      const res = (await portal(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body).message).toMatch(/billing access is currently paused/i);
    });

    it('returns the Stripe portal URL', async () => {
      const billing = await import('../../../src/services/billing.js');
      const { portal } = await import('../../../src/handlers/billing/handler.js');

      vi.mocked(billing.createPortalSession).mockResolvedValueOnce({
        url: 'https://billing.stripe.test/portal_abc',
      });

      const res = (await portal(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ url: 'https://billing.stripe.test/portal_abc' });
      expect(billing.createPortalSession).toHaveBeenCalledWith(
        'hh-1',
        expect.stringContaining('/settings/billing')
      );
    });

    it('translates service errors (no customer on file) to 400', async () => {
      const billing = await import('../../../src/services/billing.js');
      const { portal } = await import('../../../src/handlers/billing/handler.js');

      vi.mocked(billing.createPortalSession).mockRejectedValueOnce(
        new Error('No Stripe customer on file for this household')
      );

      const res = (await portal(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(400);
      expect(res.body).toMatch(/no stripe customer/i);
    });
  });

  describe('webhook', () => {
    it('returns 400 when the Stripe-Signature header is missing', async () => {
      const { webhook } = await import('../../../src/handlers/billing/handler.js');

      const res = (await webhook(
        buildEvent({
          body: '{"id":"evt_1"}',
          headers: { 'content-type': 'application/json' },
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(400);
      expect(res.body).toMatch(/missing stripe signature/i);
    });

    it('returns 500 when STRIPE_WEBHOOK_SECRET is not configured', async () => {
      delete process.env.STRIPE_WEBHOOK_SECRET;
      const { webhook } = await import('../../../src/handlers/billing/handler.js');

      const res = (await webhook(
        buildEvent({
          body: '{"id":"evt_1"}',
          headers: { 'stripe-signature': 't=1,v1=sig' },
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      // 5xx responses go through middy's httpErrorHandler with `expose: false`,
      // so the message is intentionally suppressed (no internal leak). Only
      // assert the status code — body is undefined.
      expect(res.statusCode).toBe(500);
    });

    it('returns 400 when Stripe signature verification fails', async () => {
      const billing = await import('../../../src/services/billing.js');
      const { webhook } = await import('../../../src/handlers/billing/handler.js');

      // getStripe() is mocked; emulate its webhooks.constructEvent surface
      // throwing the canonical SignatureVerificationError shape.
      vi.mocked(billing.getStripe).mockReturnValueOnce({
        webhooks: {
          constructEvent: vi.fn(() => {
            throw new Error('No signatures found matching the expected signature');
          }),
        },
      } as unknown as ReturnType<typeof billing.getStripe>);

      const res = (await webhook(
        buildEvent({
          body: '{"id":"evt_1"}',
          headers: { 'stripe-signature': 't=1,v1=badsig' },
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(400);
      expect(res.body).toMatch(/webhook signature failed/i);
    });

    it('verifies + applies the Stripe event on success', async () => {
      const billing = await import('../../../src/services/billing.js');
      const { webhook } = await import('../../../src/handlers/billing/handler.js');

      const fakeEvent = { id: 'evt_1', type: 'checkout.session.completed' };
      const constructEvent = vi.fn(() => fakeEvent);
      vi.mocked(billing.getStripe).mockReturnValueOnce({
        webhooks: { constructEvent },
      } as unknown as ReturnType<typeof billing.getStripe>);
      vi.mocked(billing.applyStripeEvent).mockResolvedValueOnce(undefined);

      const res = (await webhook(
        buildEvent({
          body: '{"id":"evt_1","type":"checkout.session.completed"}',
          headers: { 'stripe-signature': 't=1,v1=goodsig' },
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ received: true });
      expect(constructEvent).toHaveBeenCalledWith(
        '{"id":"evt_1","type":"checkout.session.completed"}',
        't=1,v1=goodsig',
        'whsec_test'
      );
      expect(billing.applyStripeEvent).toHaveBeenCalledWith(fakeEvent);
    });
  });
});
