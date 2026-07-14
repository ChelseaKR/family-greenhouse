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
  });

  afterEach(() => {
    delete process.env.PAYMENTS_ENABLED;
  });

  describe('listPlans', () => {
    it('returns a cacheable, explicitly unavailable catalog with no public prices', async () => {
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
        paymentsAvailable: false,
        commercialHold: { active: true, effectiveDate: '2026-07-14' },
      });
      expect(body.plans).toHaveLength(3);
      expect(body.plans.map((p: { id: string }) => p.id).sort()).toEqual([
        'garden',
        'greenhouse',
        'seedling',
      ]);
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
      expect(JSON.parse(res.body)).toMatchObject({ planId: 'garden', stripeCustomerId: 'cus_1' });
      expect(billing.getHouseholdSubscription).toHaveBeenCalledWith('hh-1');
    });

    it('includes usage (counters + plan caps) so the UI can render meters', async () => {
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
      expect(JSON.parse(res.body).usage).toEqual({
        plantCount: 42,
        maxPlants: 500,
        memberCount: 3,
        maxMembers: 6,
      });
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

      const usage = JSON.parse(res.body).usage;
      expect(usage).toEqual({ plantCount: 25, maxPlants: 10, memberCount: 8, maxMembers: 6 });
      expect(usage.plantCount).toBeGreaterThan(usage.maxPlants);
      expect(usage.memberCount).toBeGreaterThan(usage.maxMembers);
    });

    it('tolerates missing counters (legacy households) as zero usage', async () => {
      const billing = await import('../../../src/services/billing.js');
      const { getCurrentSubscription } = await import('../../../src/handlers/billing/handler.js');
      vi.mocked(billing.getHouseholdSubscription).mockResolvedValueOnce({ planId: 'greenhouse' });
      // Default beforeEach mock: { plantCount: 0, memberCount: 0 }.

      const res = (await getCurrentSubscription(
        buildEvent({ httpMethod: 'GET' }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(JSON.parse(res.body).usage).toEqual({
        plantCount: 0,
        maxPlants: 5000,
        memberCount: 0,
        maxMembers: 50,
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

    it('passes interval=year through to the checkout session', async () => {
      const billing = await import('../../../src/services/billing.js');
      const { checkout } = await import('../../../src/handlers/billing/handler.js');

      vi.mocked(billing.createCheckoutSession).mockResolvedValueOnce({
        url: 'https://checkout.stripe.test/annual',
      });

      const res = (await checkout(
        buildEvent({
          body: JSON.stringify({ planId: 'greenhouse', interval: 'year' }),
          headers: { 'content-type': 'application/json' },
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(200);
      expect(billing.createCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({ planId: 'greenhouse', interval: 'year' })
      );
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

    it('passes interval=lifetime through to the checkout session for Garden', async () => {
      const billing = await import('../../../src/services/billing.js');
      const { checkout } = await import('../../../src/handlers/billing/handler.js');

      vi.mocked(billing.createCheckoutSession).mockResolvedValueOnce({
        url: 'https://checkout.stripe.test/lifetime',
      });

      const res = (await checkout(
        buildEvent({
          body: JSON.stringify({ planId: 'garden', interval: 'lifetime' }),
          headers: { 'content-type': 'application/json' },
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(200);
      expect(billing.createCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({ planId: 'garden', interval: 'lifetime' })
      );
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
