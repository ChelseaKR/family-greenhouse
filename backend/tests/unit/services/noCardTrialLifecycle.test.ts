/**
 * The no-card Garden trial end to end at the service boundary (ADR 0027): it is
 * created with a household, it runs and ends on the clock, and it is never a
 * Stripe object at any point.
 *
 * DynamoDB is a small in-memory table, so the rows the real services write are
 * the rows the real resolvers read back, and any command the trial has no
 * business sending (an update, a delete) fails the test by not being modelled.
 * The Stripe SDK is replaced by a recorder, so ANY touch of it (constructing a
 * client, reading a resource, calling a method) is visible. STRIPE_SECRET_KEY is
 * set, so a path that tried to reach Stripe would get as far as the SDK.
 *
 * Synthetic fixtures only.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

const h = vi.hoisted(() => ({
  table: new Map<string, Record<string, unknown>>(),
  sent: [] as Array<{ name: string; input: Record<string, any> }>,
  stripeTouches: [] as string[],
}));

vi.mock('stripe', () => {
  const recorder = (path: string): unknown =>
    new Proxy(function stripeRecorder() {}, {
      get(_target, prop) {
        if (prop === 'then') return undefined;
        h.stripeTouches.push(`${path}.${String(prop)}`);
        return recorder(`${path}.${String(prop)}`);
      },
      apply() {
        h.stripeTouches.push(`${path}()`);
        return Promise.resolve({});
      },
    });
  return {
    default: vi.fn(function StripeConstructor() {
      h.stripeTouches.push('new Stripe()');
      return recorder('stripe');
    }),
  };
});

vi.mock('../../../src/utils/dynamodb.js', () => {
  const keyOf = (k: Record<string, unknown>) => `${String(k.PK)}|${String(k.SK)}`;
  return {
    TABLE_NAME: 'test-table',
    dynamodb: {
      send: vi.fn(
        async (command: { constructor: { name: string }; input: Record<string, any> }) => {
          const name = command.constructor.name;
          const input = command.input;
          h.sent.push({ name, input });
          if (name === 'GetCommand') return { Item: h.table.get(keyOf(input.Key)) };
          if (name === 'TransactWriteCommand') {
            const items = input.TransactItems as Array<{
              Put?: { Item: Record<string, unknown>; ConditionExpression?: string };
            }>;
            const reasons = items.map((item) =>
              item.Put?.ConditionExpression === 'attribute_not_exists(PK)' &&
              h.table.has(keyOf(item.Put.Item))
                ? { Code: 'ConditionalCheckFailed' }
                : { Code: 'None' }
            );
            if (reasons.some((reason) => reason.Code !== 'None')) {
              throw Object.assign(new Error('Transaction cancelled'), {
                name: 'TransactionCanceledException',
                CancellationReasons: reasons,
              });
            }
            for (const item of items) {
              if (item.Put) h.table.set(keyOf(item.Put.Item), structuredClone(item.Put.Item));
            }
            return {};
          }
          throw new Error(`The trial lifecycle test does not model ${name}`);
        }
      ),
    },
  };
});

// The two reads behind GET /billing/me that are not the household row. Mocked
// to fixed values so the test is about which CAPS are published, not counting.
vi.mock('../../../src/services/householdUsage.js', () => ({
  getHouseholdCounters: vi.fn(async () => ({ plantCount: 25, memberCount: 2 })),
}));
vi.mock('../../../src/services/identifyCredits.js', () => ({
  getCreditBalance: vi.fn(async () => ({ remaining: 0, expiresAt: null })),
}));

import * as householdService from '../../../src/services/householdService.js';
import * as billing from '../../../src/services/billing.js';
import * as plans from '../../../src/models/plans.js';

const DAY = 24 * 60 * 60 * 1000;
const CREATED = Date.parse('2026-09-20T23:30:00.000Z');
const ENDS_ISO = '2026-10-04T23:30:00.000Z';

function meEvent(userId: string, householdId: string): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    path: '/billing/me',
    pathParameters: null,
    queryStringParameters: null,
    requestContext: {
      authorizer: {
        claims: {
          sub: userId,
          email: `synthetic-${userId}`,
          'custom:household_id': householdId,
          'custom:household_role': 'admin',
        },
      },
    } as APIGatewayProxyEvent['requestContext'],
    resource: '/',
    stageVariables: null,
  };
}

/** GET /billing/me through the real handler, auth middleware included. */
async function billingMe(userId: string, householdId: string) {
  const { __resetMembershipCacheForTests } = await import('../../../src/middleware/auth.js');
  const { setCachedMembership } = await import('../../../src/utils/membershipCache.js');
  __resetMembershipCacheForTests();
  setCachedMembership(userId, householdId, 'admin');
  const { getCurrentSubscription } = await import('../../../src/handlers/billing/handler.js');
  const res = (await getCurrentSubscription(
    meEvent(userId, householdId),
    {} as Context,
    () => {}
  )) as APIGatewayProxyResult;
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body) as Record<string, any>;
}

function createFor(userId: string, name: string, at: number) {
  return householdService.createHousehold(
    { name },
    userId,
    `Synthetic ${userId}`,
    `synthetic-${userId}`,
    new Date(at)
  );
}

beforeEach(() => {
  h.table.clear();
  h.sent.length = 0;
  h.stripeTouches.length = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  process.env.STRIPE_SECRET_KEY = 'sk_test_synthetic_never_sent';
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.STRIPE_SECRET_KEY;
});

describe('no-card trial lifecycle (ADR 0027)', () => {
  it('starts with a new household: 14 days of Garden and the account claim commit in one transaction, and no Stripe object is touched', async () => {
    vi.setSystemTime(CREATED);
    const household = await createFor('user-a', 'Synthetic Home', CREATED);

    const writes = h.sent.filter((s) => s.name === 'TransactWriteCommand');
    expect(writes).toHaveLength(1);
    const [row, member, claim] = writes[0].input.TransactItems.map(
      (t: { Put: Record<string, any> }) => t.Put
    );
    expect(row.Item).toMatchObject({
      PK: `HOUSEHOLD#${household.id}`,
      SK: 'METADATA',
      noCardTrialStartedAt: '2026-09-20T23:30:00.000Z',
      noCardTrialEndsAt: ENDS_ISO,
    });
    expect(member.Item).toMatchObject({ SK: 'MEMBER#user-a', role: 'admin' });
    expect(claim).toMatchObject({
      Item: { PK: 'USER#user-a', SK: 'NO_CARD_TRIAL', householdId: household.id },
      ConditionExpression: 'attribute_not_exists(PK)',
    });
    // The trial writes no billing attribute of any kind.
    for (const attribute of [
      'planId',
      'stripeCustomerId',
      'stripeSubscriptionId',
      'subscriptionStatus',
      'subscriptionCurrentPeriodEnd',
      'trialConsumedAt',
      'lifetimePlanId',
    ]) {
      expect(row.Item).not.toHaveProperty(attribute);
    }

    const sub = await billing.getHouseholdSubscription(household.id);
    expect(sub.noCardTrialEndsAt).toBe(ENDS_ISO);
    expect(plans.getEntitledPlan(sub).id).toBe('garden');
    expect(plans.getMeteredPlanId(sub)).toBe('seedling');
    // The card-based trial a paid subscription starts with is untouched.
    expect(sub.trialAvailable).toBe(true);
    expect(h.stripeTouches).toEqual([]);
  });

  it("is one per account: the same account's next household is created with no trial, and another account still gets its own", async () => {
    vi.setSystemTime(CREATED);
    const first = await createFor('user-a', 'Synthetic Home', CREATED);
    vi.setSystemTime(CREATED + 2 * DAY);
    const second = await createFor('user-a', 'Second Synthetic Home', CREATED + 2 * DAY);

    const secondRow = h.table.get(`HOUSEHOLD#${second.id}|METADATA`);
    expect(secondRow).toMatchObject({ id: second.id, createdBy: 'user-a' });
    expect(secondRow).not.toHaveProperty('noCardTrialEndsAt');
    expect(secondRow).not.toHaveProperty('noCardTrialStartedAt');
    expect(h.table.get('USER#user-a|NO_CARD_TRIAL')).toMatchObject({ householdId: first.id });

    const secondSub = await billing.getHouseholdSubscription(second.id);
    expect(plans.noCardTrialState(secondSub)).toBe('none');
    expect(plans.getEntitledPlan(secondSub).id).toBe('seedling');

    const other = await createFor('user-b', 'Neighbouring Synthetic Home', CREATED + 2 * DAY);
    expect(h.table.get(`HOUSEHOLD#${other.id}|METADATA`)).toMatchObject({
      noCardTrialEndsAt: new Date(CREATED + 16 * DAY).toISOString(),
    });
    expect(h.stripeTouches).toEqual([]);
  });

  it('runs and ends on the clock alone: Garden caps on day 13, Seedling caps at day 14, with only reads in between and no Stripe call', async () => {
    vi.setSystemTime(CREATED);
    const household = await createFor('user-a', 'Synthetic Home', CREATED);
    const sentAtCreation = h.sent.length;

    vi.setSystemTime(CREATED + 13 * DAY);
    const running = await billingMe('user-a', household.id);
    expect(running.noCardTrial).toEqual({ state: 'active', endsAt: ENDS_ISO });
    // The plan on file never changes; the entitlement does.
    expect(running.planId).toBe('seedling');
    expect(running.usageDetail).toEqual({
      plantCount: 25,
      maxPlants: 200,
      memberCount: 2,
      maxMembers: null,
    });
    expect(running).not.toHaveProperty('noCardTrialEndsAt');

    vi.setSystemTime(Date.parse(ENDS_ISO));
    const ended = await billingMe('user-a', household.id);
    expect(ended.noCardTrial).toEqual({ state: 'ended', endsAt: ENDS_ISO });
    expect(ended.planId).toBe('seedling');
    expect(ended.usageDetail).toEqual({
      plantCount: 25,
      maxPlants: 20,
      memberCount: 2,
      maxMembers: 3,
    });

    const afterCreation = h.sent.slice(sentAtCreation).map((s) => s.name);
    expect(afterCreation.length).toBeGreaterThan(0);
    expect([...new Set(afterCreation)]).toEqual(['GetCommand']);
    expect(h.table.get(`HOUSEHOLD#${household.id}|METADATA`)).toMatchObject({
      noCardTrialEndsAt: ENDS_ISO,
    });
    expect(h.stripeTouches).toEqual([]);
  });

  it('grants nothing retroactively: a household created before the trial shipped stays on Seedling, even inside 14 days of its creation', async () => {
    const now = Date.parse('2026-09-13T12:00:00.000Z');
    vi.setSystemTime(now);
    h.table.set('HOUSEHOLD#hh-legacy|METADATA', {
      PK: 'HOUSEHOLD#hh-legacy',
      SK: 'METADATA',
      entityType: 'Household',
      id: 'hh-legacy',
      name: 'Legacy Synthetic Home',
      createdAt: new Date(now - 2 * DAY).toISOString(),
      createdBy: 'user-legacy',
      memberCount: 2,
      plantCount: 25,
    });

    const sub = await billing.getHouseholdSubscription('hh-legacy');
    expect(sub.noCardTrialEndsAt).toBeUndefined();
    expect(plans.noCardTrialState(sub)).toBe('none');
    expect(plans.getEntitledPlan(sub).id).toBe('seedling');

    const me = await billingMe('user-legacy', 'hh-legacy');
    expect(me.noCardTrial).toBeNull();
    expect(me.usageDetail).toMatchObject({ maxPlants: 20, maxMembers: 3 });
    expect(h.stripeTouches).toEqual([]);
  });

  describe('the household on a card-based Stripe Garden trial since 2026-09-03', () => {
    const NOW = Date.parse('2026-09-13T20:00:00.000Z');
    const ROW = {
      PK: 'HOUSEHOLD#hh-card-trial',
      SK: 'METADATA',
      entityType: 'Household',
      id: 'hh-card-trial',
      name: 'Card Trial Synthetic Home',
      createdAt: '2026-07-10T09:00:00.000Z',
      createdBy: 'user-card',
      memberCount: 2,
      plantCount: 25,
      planId: 'garden',
      stripeCustomerId: 'cus_synthetic_card_trial',
      stripeSubscriptionId: 'sub_synthetic_card_trial',
      subscriptionStatus: 'trialing',
      subscriptionCurrentPeriodEnd: '2026-09-17T02:00:00.000Z',
      trialConsumedAt: '2026-09-03T02:00:00.000Z',
      lastStripeEventCreated: 1788400800,
    };

    it.each([
      ['as its row is today', {}],
      [
        'even with no-card trial attributes planted on its row',
        {
          noCardTrialStartedAt: '2026-09-12T00:00:00.000Z',
          noCardTrialEndsAt: '2026-09-26T00:00:00.000Z',
        },
      ],
    ] as Array<[string, Record<string, string>]>)(
      'resolves, meters and publishes exactly as a Stripe card trial, %s',
      async (_label, planted) => {
        vi.setSystemTime(NOW);
        h.table.set('HOUSEHOLD#hh-card-trial|METADATA', { ...ROW, ...planted });

        const sub = await billing.getHouseholdSubscription('hh-card-trial');
        expect(sub).toEqual({
          planId: 'garden',
          stripeCustomerId: 'cus_synthetic_card_trial',
          stripeSubscriptionId: 'sub_synthetic_card_trial',
          status: 'trialing',
          currentPeriodEnd: '2026-09-17T02:00:00.000Z',
          trialAvailable: false,
          noCardTrialEndsAt: planted.noCardTrialEndsAt,
        });
        expect(plans.hasStripeEntitlementState(sub)).toBe(true);
        expect(plans.noCardTrialState(sub)).toBe('none');
        expect(plans.getEntitledPlan(sub).id).toBe('garden');
        expect(plans.getEntitledPlanForIssuedGrant(sub).id).toBe('garden');
        // Garden's AI allowances (30 identifications, the full chat budget),
        // not Seedling's.
        expect(plans.getMeteredPlanId(sub)).toBe('garden');

        const me = await billingMe('user-card', 'hh-card-trial');
        expect(me).toMatchObject({
          planId: 'garden',
          status: 'trialing',
          currentPeriodEnd: '2026-09-17T02:00:00.000Z',
          trialAvailable: false,
          noCardTrial: null,
          usageDetail: { plantCount: 25, maxPlants: 200, memberCount: 2, maxMembers: null },
        });
        expect(me).not.toHaveProperty('noCardTrialEndsAt');
        expect(h.sent.every((s) => s.name === 'GetCommand')).toBe(true);
        expect(h.stripeTouches).toEqual([]);
      }
    );

    it("its admin creating another household leaves this household's row byte-for-byte unchanged", async () => {
      vi.setSystemTime(NOW);
      h.table.set('HOUSEHOLD#hh-card-trial|METADATA', { ...ROW });
      const before = JSON.stringify(h.table.get('HOUSEHOLD#hh-card-trial|METADATA'));

      await createFor('user-card', 'Second Synthetic Home', NOW);

      expect(JSON.stringify(h.table.get('HOUSEHOLD#hh-card-trial|METADATA'))).toBe(before);
      const writtenKeys = h.sent
        .filter((s) => s.name === 'TransactWriteCommand')
        .flatMap((s) =>
          s.input.TransactItems.map((t: { Put: { Item: { PK: string } } }) => t.Put.Item.PK)
        );
      expect(writtenKeys).not.toContain('HOUSEHOLD#hh-card-trial');
      expect(h.stripeTouches).toEqual([]);
    });
  });
});

describe('no-card trial: only household creation writes it', () => {
  const SRC = fileURLToPath(new URL('../../../src/', import.meta.url));

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return path.endsWith('.ts') ? [path] : [];
    });
  }

  it('the trial start attribute is written in exactly one production module, and the dev server that mirrors it', () => {
    const writers = sourceFiles(SRC)
      .filter((path) => readFileSync(path, 'utf8').includes('noCardTrialStartedAt'))
      .map((path) => path.slice(SRC.length))
      .sort();
    expect(writers).toEqual(['services/householdService.ts']);
  });

  it('no Stripe path can write or clear the trial end: the webhook write map does not name it', () => {
    const source = readFileSync(join(SRC, 'services/billing.ts'), 'utf8');
    const start = source.indexOf('const map: Record<SubscriptionWriteField, string> = {');
    expect(start).toBeGreaterThan(-1);
    const map = source.slice(start, source.indexOf('};', start));
    expect(map).toContain('subscriptionStatus');
    expect(map).not.toContain('noCardTrial');
  });
});
