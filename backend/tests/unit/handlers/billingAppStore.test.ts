/**
 * The Apple In-App Purchase routes (ADR 0041) and the web checkout's guard
 * against a household that pays Apple. The services are mocked; their own
 * suites cover what they do.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

vi.mock('../../../src/services/householdAudit.js');
vi.mock('../../../src/services/billing.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/services/billing.js')>(
    '../../../src/services/billing.js'
  );
  return {
    ...actual,
    getHouseholdSubscription: vi.fn(),
    createCheckoutSession: vi.fn(),
  };
});
vi.mock('../../../src/services/householdUsage.js', () => ({ getHouseholdCounters: vi.fn() }));
vi.mock('../../../src/services/identifyCredits.js', () => ({ getCreditBalance: vi.fn() }));
vi.mock('../../../src/services/appStoreBilling.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/services/appStoreBilling.js')>(
    '../../../src/services/appStoreBilling.js'
  );
  return {
    ...actual,
    purchaseRefusal: vi.fn(),
    getOrCreateAccountToken: vi.fn(),
    appStoreBlocksWebCheckout: vi.fn(),
    applyNotification: vi.fn(),
  };
});

import { getHouseholdCounters } from '../../../src/services/householdUsage.js';
import { getCreditBalance } from '../../../src/services/identifyCredits.js';
import * as billing from '../../../src/services/billing.js';
import * as appStoreBilling from '../../../src/services/appStoreBilling.js';
import { AppStoreVerificationError } from '../../../src/services/appStoreJws.js';

const ctx = {} as Context;

function event(body: unknown, overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: body === null ? null : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
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

const call = async (
  h: (e: APIGatewayProxyEvent, c: Context, cb: () => void) => unknown,
  e: APIGatewayProxyEvent
) => (await h(e, ctx, () => {})) as APIGatewayProxyResult;

beforeEach(async () => {
  vi.resetAllMocks();
  process.env.PAYMENTS_ENABLED = '1';
  process.env.APP_STORE_BILLING_ENABLED = '1';
  const { __resetMembershipCacheForTests } = await import('../../../src/middleware/auth.js');
  __resetMembershipCacheForTests();
  const { setCachedMembership } = await import('../../../src/utils/membershipCache.js');
  setCachedMembership('user-1', 'hh-1', 'admin');
  vi.mocked(getHouseholdCounters).mockResolvedValue({ plantCount: 0, memberCount: 0 });
  vi.mocked(getCreditBalance).mockResolvedValue({ remaining: 0, expiresAt: null });
});

afterEach(() => {
  delete process.env.PAYMENTS_ENABLED;
  delete process.env.APP_STORE_BILLING_ENABLED;
});

describe('POST /billing/app-store/purchase-intent', () => {
  it('is 404 while the switch is off, and while payments are off', async () => {
    const { purchaseIntent } = await import('../../../src/handlers/billing/appStore.js');
    delete process.env.APP_STORE_BILLING_ENABLED;
    expect((await call(purchaseIntent, event({ planId: 'garden' }))).statusCode).toBe(404);
    process.env.APP_STORE_BILLING_ENABLED = 'true';
    expect((await call(purchaseIntent, event({ planId: 'garden' }))).statusCode).toBe(404);
    process.env.APP_STORE_BILLING_ENABLED = '1';
    process.env.PAYMENTS_ENABLED = '0';
    expect((await call(purchaseIntent, event({ planId: 'garden' }))).statusCode).toBe(404);
    expect(appStoreBilling.getOrCreateAccountToken).not.toHaveBeenCalled();
  });

  it('hands back the product and the household token', async () => {
    const { purchaseIntent } = await import('../../../src/handlers/billing/appStore.js');
    vi.mocked(appStoreBilling.purchaseRefusal).mockResolvedValue(null);
    vi.mocked(appStoreBilling.getOrCreateAccountToken).mockResolvedValue('token-1');
    const res = await call(purchaseIntent, event({ planId: 'greenhouse' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      productId: 'net.familygreenhouse.app.greenhouse.monthly',
      appAccountToken: 'token-1',
    });
  });

  it('refuses a second way to pay with a neutral message and a code', async () => {
    const { purchaseIntent } = await import('../../../src/handlers/billing/appStore.js');
    vi.mocked(appStoreBilling.purchaseRefusal).mockResolvedValue('STRIPE_SUBSCRIPTION_ACTIVE');
    const res = await call(purchaseIntent, event({ planId: 'garden' }));
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.details).toEqual({ code: 'STRIPE_SUBSCRIPTION_ACTIVE' });
    expect(body.message).not.toMatch(/web|stripe|browser/i);
    expect(appStoreBilling.getOrCreateAccountToken).not.toHaveBeenCalled();
  });

  it('is admin-only', async () => {
    const { purchaseIntent } = await import('../../../src/handlers/billing/appStore.js');
    const { setCachedMembership } = await import('../../../src/utils/membershipCache.js');
    setCachedMembership('user-1', 'hh-1', 'member');
    const e = event({ planId: 'garden' });
    (e.requestContext.authorizer as { claims: Record<string, string> }).claims[
      'custom:household_role'
    ] = 'member';
    expect((await call(purchaseIntent, e)).statusCode).toBe(403);
  });
});

describe('POST /billing/app-store/notifications', () => {
  const noAuth = {
    requestContext: { identity: { sourceIp: '10.0.0.1' } },
  } as Partial<APIGatewayProxyEvent>;

  it('acknowledges a handled notification', async () => {
    const { notifications } = await import('../../../src/handlers/billing/appStore.js');
    vi.mocked(appStoreBilling.applyNotification).mockResolvedValue({
      outcome: 'applied',
      householdId: 'hh-1',
      notificationType: 'DID_RENEW',
    });
    const res = await call(notifications, event({ signedPayload: 'a.b.c' }, noAuth));
    expect(res.statusCode).toBe(200);
  });

  it('is 400 for a payload that does not verify', async () => {
    const { notifications } = await import('../../../src/handlers/billing/appStore.js');
    vi.mocked(appStoreBilling.applyNotification).mockRejectedValue(
      new AppStoreVerificationError('JWS signature does not verify')
    );
    const res = await call(notifications, event({ signedPayload: 'a.b.c' }, noAuth));
    expect(res.statusCode).toBe(400);
  });

  it('is 404 while the switch is off', async () => {
    const { notifications } = await import('../../../src/handlers/billing/appStore.js');
    delete process.env.APP_STORE_BILLING_ENABLED;
    const res = await call(notifications, event({ signedPayload: 'a.b.c' }, noAuth));
    expect(res.statusCode).toBe(404);
    expect(appStoreBilling.applyNotification).not.toHaveBeenCalled();
  });
});

describe('the web checkout and GET /billing/me', () => {
  it('refuses a web plan checkout for a household paying Apple, whatever the switch says', async () => {
    delete process.env.APP_STORE_BILLING_ENABLED;
    const { checkout } = await import('../../../src/handlers/billing/handler.js');
    vi.mocked(appStoreBilling.appStoreBlocksWebCheckout).mockResolvedValue(true);
    const res = await call(checkout, event({ planId: 'garden' }));
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).details).toEqual({ code: 'APP_STORE_SUBSCRIBED' });
    expect(billing.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('publishes the App Store subscription with its state, and no transaction id', async () => {
    const { getCurrentSubscription } = await import('../../../src/handlers/billing/handler.js');
    vi.mocked(billing.getHouseholdSubscription).mockResolvedValue({
      planId: 'seedling',
      appStore: {
        planId: 'garden',
        productId: 'net.familygreenhouse.app.garden.monthly',
        expiresAt: '2999-01-01T00:00:00.000Z',
        environment: 'Production',
      },
    });
    const res = await call(getCurrentSubscription, event(null, { httpMethod: 'GET' }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.appStore).toEqual({
      planId: 'garden',
      productId: 'net.familygreenhouse.app.garden.monthly',
      expiresAt: '2999-01-01T00:00:00.000Z',
      environment: 'Production',
      state: 'active',
    });
    expect(body.usageDetail.maxPlants).toBe(200);
  });
});
