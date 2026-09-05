/**
 * GET /chat/budget — the READ side of the chat token budget. Once the
 * enforced cap is tier-aware the reported cap must be the same number, or the
 * client's "used X of Y" meter is a confident wrong value. Same resolution
 * shape as the leaf-health handler: no plan lookup until a per-tier value is
 * configured, and a lookup failure is a 503, never a stand-in cap.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

vi.mock('../../../src/services/chat/index.js', () => ({
  getConversationHistory: vi.fn(),
  runChatTurn: vi.fn(),
}));
vi.mock('../../../src/services/chat/persistence.js', () => ({ getBudget: vi.fn() }));
vi.mock('../../../src/services/chatReports.js', () => ({ saveChatReport: vi.fn() }));
vi.mock('../../../src/services/billing.js', () => ({
  getHouseholdSubscription: vi.fn(),
}));

import { getBudget } from '../../../src/services/chat/persistence.js';
import * as billing from '../../../src/services/billing.js';

const TIER_ENV = [
  'CHAT_BUDGET_INPUT_TOKENS_SEEDLING',
  'CHAT_BUDGET_OUTPUT_TOKENS_SEEDLING',
  'CHAT_BUDGET_INPUT_TOKENS_GARDEN',
  'CHAT_BUDGET_OUTPUT_TOKENS_GARDEN',
  'CHAT_BUDGET_INPUT_TOKENS_GREENHOUSE',
  'CHAT_BUDGET_OUTPUT_TOKENS_GREENHOUSE',
];

function clearTierEnv() {
  for (const name of TIER_ENV) delete process.env[name];
}

// Household-scoped route (requireHousehold): claims carry custom:household_id
// and the membership cache is pre-seeded to keep authMiddleware off the table.
function buildEvent(): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    path: '/chat/budget',
    pathParameters: null,
    queryStringParameters: null,
    requestContext: {
      authorizer: {
        claims: { sub: 'user-1', email: 'a@b.com', 'custom:household_id': 'hh-1' },
      },
      identity: { sourceIp: '127.0.0.1' },
    } as APIGatewayProxyEvent['requestContext'],
    resource: '/',
    stageVariables: null,
  };
}

const ctx = {} as Context;

async function subject() {
  return (await import('../../../src/handlers/chat/handler.js')).getChatBudget;
}

const USED = {
  householdId: 'hh-1',
  yearMonth: '2026-09',
  inputTokens: 1234,
  outputTokens: 56,
  costUsd: 0.012345,
};

describe('GET /chat/budget', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    clearTierEnv();
    const { __resetMembershipCacheForTests } = await import('../../../src/middleware/auth.js');
    const { setCachedMembership } = await import('../../../src/utils/membershipCache.js');
    __resetMembershipCacheForTests();
    setCachedMembership('user-1', 'hh-1', 'member');
    vi.mocked(getBudget).mockResolvedValue(USED);
  });
  afterEach(() => {
    clearTierEnv();
  });

  it('reports the flat cap with no plan lookup while nothing per-tier is configured', async () => {
    const getChatBudget = await subject();
    const res = (await getChatBudget(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      yearMonth: '2026-09',
      inputTokensUsed: 1234,
      outputTokensUsed: 56,
      inputTokensCap: 250000,
      outputTokensCap: 50000,
      costUsd: 0.0123,
    });
    // The pre-tiering path, read for read: the household row is never read.
    expect(billing.getHouseholdSubscription).not.toHaveBeenCalled();
    expect(getBudget).toHaveBeenCalledWith('hh-1');
  });

  it("reports the household's tier cap once a per-tier value is configured (one plan read)", async () => {
    process.env.CHAT_BUDGET_INPUT_TOKENS_SEEDLING = '62500';
    process.env.CHAT_BUDGET_OUTPUT_TOKENS_SEEDLING = '12500';
    const getChatBudget = await subject();

    vi.mocked(billing.getHouseholdSubscription).mockResolvedValueOnce({
      planId: 'seedling',
    } as Awaited<ReturnType<typeof billing.getHouseholdSubscription>>);
    let res = (await getChatBudget(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ inputTokensCap: 62500, outputTokensCap: 12500 });
    expect(billing.getHouseholdSubscription).toHaveBeenCalledTimes(1);
    expect(billing.getHouseholdSubscription).toHaveBeenCalledWith('hh-1');

    // A tier without its own values still reports the flat cap.
    vi.mocked(billing.getHouseholdSubscription).mockResolvedValueOnce({
      planId: 'garden',
    } as Awaited<ReturnType<typeof billing.getHouseholdSubscription>>);
    res = (await getChatBudget(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;
    expect(JSON.parse(res.body)).toMatchObject({ inputTokensCap: 250000, outputTokensCap: 50000 });
  });

  it('reports the ENTITLED tier cap, not the plan row, once a card has failed (#476)', async () => {
    // The turn itself is enforced against getEntitledPlan (services/chat/
    // index.ts), so a past_due Greenhouse household is refused outright. This
    // endpoint read `planId` and reported the Greenhouse cap anyway — a
    // confident "used X of Y" whose Y is not the Y anything enforces.
    process.env.CHAT_BUDGET_INPUT_TOKENS_SEEDLING = '62500';
    process.env.CHAT_BUDGET_OUTPUT_TOKENS_SEEDLING = '12500';
    process.env.CHAT_BUDGET_INPUT_TOKENS_GREENHOUSE = '900000';
    process.env.CHAT_BUDGET_OUTPUT_TOKENS_GREENHOUSE = '180000';
    const getChatBudget = await subject();

    vi.mocked(billing.getHouseholdSubscription).mockResolvedValueOnce({
      planId: 'greenhouse',
      status: 'past_due',
    } as Awaited<ReturnType<typeof billing.getHouseholdSubscription>>);
    const res = (await getChatBudget(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      inputTokensCap: 62500,
      outputTokensCap: 12500,
    });
  });

  it('still reports the paid cap while the subscription is in good standing (#476)', async () => {
    // The negative control on the conversion: entitlement is not a blanket
    // downgrade. `active`, `trialing` and an absent status all still grant it.
    process.env.CHAT_BUDGET_INPUT_TOKENS_GREENHOUSE = '900000';
    process.env.CHAT_BUDGET_OUTPUT_TOKENS_GREENHOUSE = '180000';
    const getChatBudget = await subject();

    for (const status of ['active', 'trialing', undefined]) {
      vi.mocked(billing.getHouseholdSubscription).mockResolvedValueOnce({
        planId: 'greenhouse',
        ...(status ? { status } : {}),
      } as Awaited<ReturnType<typeof billing.getHouseholdSubscription>>);
      const res = (await getChatBudget(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;
      expect(JSON.parse(res.body)).toMatchObject({
        inputTokensCap: 900000,
        outputTokensCap: 180000,
      });
    }
  });

  it('503s — without reading the usage row — when the cap cannot be resolved (never report a cap we could not determine)', async () => {
    process.env.CHAT_BUDGET_INPUT_TOKENS_SEEDLING = '62500';
    vi.mocked(billing.getHouseholdSubscription).mockRejectedValueOnce(new Error('ddb down'));
    const getChatBudget = await subject();

    const res = (await getChatBudget(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;

    expect(res.statusCode).toBe(503);
    expect(res.body).toMatch(/temporarily unavailable/i);
    expect(getBudget).not.toHaveBeenCalled();
  });
});
