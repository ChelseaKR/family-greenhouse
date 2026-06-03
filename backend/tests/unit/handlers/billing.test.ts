import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    process.env.FRONTEND_URL = 'https://test.familygreenhouse.net';
  });

  describe('listPlans', () => {
    it('returns the catalog as a cacheable response with all three tiers', async () => {
      const { listPlans } = await import('../../../src/handlers/billing/handler.js');
      const res = (await listPlans(
        buildEvent({ httpMethod: 'GET' }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(200);
      expect(res.headers?.['Cache-Control']).toMatch(/public.*max-age=300/);
      const body = JSON.parse(res.body);
      expect(body).toHaveLength(3);
      expect(body.map((p: { id: string }) => p.id).sort()).toEqual([
        'garden',
        'greenhouse',
        'seedling',
      ]);
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
          successUrl: expect.stringContaining('/settings/billing?status=success'),
          cancelUrl: expect.stringContaining('/settings/billing?status=cancel'),
        })
      );
    });

    it('returns 403 when the caller is a non-admin household member', async () => {
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

    it('translates upstream Stripe errors to a 5xx', async () => {
      const billing = await import('../../../src/services/billing.js');
      const { checkout } = await import('../../../src/handlers/billing/handler.js');

      vi.mocked(billing.createCheckoutSession).mockRejectedValueOnce(new Error('upstream down'));

      const res = (await checkout(
        buildEvent({
          body: JSON.stringify({ planId: 'greenhouse' }),
          headers: { 'content-type': 'application/json' },
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      // The handler throws `createHttpError(502, ...)`, but the default middy
      // `httpErrorHandler` masks all 5xx responses to a generic 500 (no body)
      // because `http-errors` sets `expose: false` on 5xx. We assert the
      // observable behavior: any 5xx is acceptable here.
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect(res.statusCode).toBeLessThan(600);
    });
  });

  describe('portal', () => {
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
