/**
 * POST /households/{id}/caretakers — the plan gate on MINTING a seat (#476).
 *
 * This call site landed AFTER #476 was written and was therefore missing from
 * that issue's own table — the evidence that a hand-maintained list of gates
 * goes stale, and the reason `scripts/check-entitlement-gates.mjs` exists.
 *
 * The gate is on CREATE only. Listing, revoking and reporting stay open on
 * every tier (see the handler's file header), so nothing already handed out is
 * trapped behind the paywall — which is what makes gating create on payment
 * status safe rather than hostile.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

vi.mock('../../../src/services/caretakerService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/caretakerService.js')>();
  return { ...actual, createCaretaker: vi.fn() };
});
vi.mock('../../../src/services/billing.js', () => ({
  getHouseholdSubscription: vi.fn(),
}));
vi.mock('../../../src/utils/auditLog.js', () => ({ audit: vi.fn() }));

import * as caretakerService from '../../../src/services/caretakerService.js';
import * as billing from '../../../src/services/billing.js';

type Subscription = Awaited<ReturnType<typeof billing.getHouseholdSubscription>>;
const subscription = (over: Record<string, unknown>) => over as unknown as Subscription;

const SEAT = {
  id: 'ct-1',
  token: 'c'.repeat(64),
  householdId: 'hh-1',
  createdBy: 'user-1',
  createdAt: '2026-09-01T00:00:00.000Z',
  name: 'Neighbour Ann',
  startsAt: '2026-09-01T00:00:00.000Z',
  expiresAt: '2026-09-08T00:00:00.000Z',
  status: 'active',
} as unknown as Awaited<ReturnType<typeof caretakerService.createCaretaker>>;

function buildEvent(): APIGatewayProxyEvent {
  return {
    body: JSON.stringify({
      name: 'Neighbour Ann',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    }),
    headers: { 'content-type': 'application/json' },
    httpMethod: 'POST',
    isBase64Encoded: false,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    path: '/households/hh-1/caretakers',
    pathParameters: { id: 'hh-1' },
    queryStringParameters: null,
    requestContext: {
      authorizer: {
        claims: {
          sub: 'user-1',
          email: 'a@b.com',
          'custom:household_id': 'hh-1',
          'custom:household_role': 'admin',
        },
      },
      identity: { sourceIp: '127.0.0.1' },
    } as APIGatewayProxyEvent['requestContext'],
    resource: '/',
    stageVariables: null,
  };
}

const ctx = {} as Context;

async function subject() {
  return (await import('../../../src/handlers/caretakers/management.js')).createCaretaker;
}

describe('POST /households/{id}/caretakers plan gate', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.FRONTEND_URL = 'https://test.familygreenhouse.net';
    const { __resetMembershipCacheForTests } = await import('../../../src/middleware/auth.js');
    const { setCachedMembership } = await import('../../../src/utils/membershipCache.js');
    __resetMembershipCacheForTests();
    // Minting a seat is admin-only on top of the plan gate.
    setCachedMembership('user-1', 'hh-1', 'admin');
    vi.mocked(caretakerService.createCaretaker).mockResolvedValue(SEAT);
  });

  it('mints for a Greenhouse household in good standing', async () => {
    const createCaretaker = await subject();
    for (const status of ['active', 'trialing', undefined]) {
      vi.mocked(billing.getHouseholdSubscription).mockResolvedValueOnce(
        subscription({ planId: 'greenhouse', ...(status ? { status } : {}) })
      );
      const res = (await createCaretaker(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(201);
    }
    expect(caretakerService.createCaretaker).toHaveBeenCalledTimes(3);
  });

  it.each(['past_due', 'unpaid', 'incomplete', 'canceled', 'paused'])(
    'refuses to mint while the card has failed (%s), though planId is still greenhouse (#476)',
    async (status) => {
      const createCaretaker = await subject();
      vi.mocked(billing.getHouseholdSubscription).mockResolvedValueOnce(
        subscription({ planId: 'greenhouse', status })
      );
      const res = (await createCaretaker(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(402);
      expect(caretakerService.createCaretaker).not.toHaveBeenCalled();
    }
  );

  it('still mints for a lifetime Greenhouse owner whose later subscription was cancelled', async () => {
    // The entitlement FLOOR: a one-time purchase has no refund path, and no
    // subscription status may fall below it.
    const createCaretaker = await subject();
    vi.mocked(billing.getHouseholdSubscription).mockResolvedValueOnce(
      subscription({ planId: 'seedling', status: 'canceled', lifetimePlanId: 'greenhouse' })
    );
    const res = (await createCaretaker(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(201);
    expect(caretakerService.createCaretaker).toHaveBeenCalled();
  });

  it('still refuses a Garden household in good standing', async () => {
    const createCaretaker = await subject();
    vi.mocked(billing.getHouseholdSubscription).mockResolvedValueOnce(
      subscription({ planId: 'garden', status: 'active' })
    );
    const res = (await createCaretaker(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(402);
    expect(caretakerService.createCaretaker).not.toHaveBeenCalled();
  });
});
