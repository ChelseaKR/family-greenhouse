/**
 * Apple In-App Purchase, server side (ADR 0041): which household a verified
 * transaction lands on, the write guards (ordering, one live Apple
 * subscription per home), notifications end to end through a throwaway
 * signing chain, and the refusals that keep a home from paying twice.
 *
 * DynamoDB is a small in-memory fake that evaluates the exact condition
 * expressions this module sends, so a changed expression fails here.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  GetCommand: vi.fn(function (input) {
    return { input, kind: 'Get' };
  }),
  PutCommand: vi.fn(function (input) {
    return { input, kind: 'Put' };
  }),
  UpdateCommand: vi.fn(function (input) {
    return { input, kind: 'Update' };
  }),
  DeleteCommand: vi.fn(function (input) {
    return { input, kind: 'Delete' };
  }),
  QueryCommand: vi.fn(function (input) {
    return { input, kind: 'Query' };
  }),
  TransactWriteCommand: vi.fn(function (input) {
    return { input, kind: 'TransactWrite' };
  }),
}));

const table = vi.hoisted(() => new Map<string, Record<string, any>>());
vi.mock('../../../src/utils/dynamodb.js', () => {
  const key = (k: { PK: string; SK: string }) => `${k.PK}|${k.SK}`;
  const conditionFailed = () =>
    Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });
  return {
    TABLE_NAME: 'test-table',
    dynamodb: {
      send: vi.fn(async (cmd: { kind: string; input: Record<string, any> }) => {
        const { input } = cmd;
        if (cmd.kind === 'Get') return { Item: table.get(key(input.Key)) };
        if (cmd.kind === 'Put') {
          if (
            input.ConditionExpression === 'attribute_not_exists(PK)' &&
            table.has(key(input.Item))
          ) {
            throw conditionFailed();
          }
          table.set(key(input.Item), { ...input.Item });
          return {};
        }
        if (cmd.kind === 'Update') {
          const row = table.get(key(input.Key));
          const v = input.ExpressionAttributeValues ?? {};
          if (input.UpdateExpression === 'SET appStoreAccountToken = :t') {
            if (!row || row.appStoreAccountToken) throw conditionFailed();
            row.appStoreAccountToken = v[':t'];
            return {};
          }
          if (input.UpdateExpression === 'SET #as = :s, #otid = :o, #sd = :d') {
            if (!row) throw conditionFailed();
            const otid = row.appStoreOriginalTransactionId;
            const ok =
              otid === undefined ||
              (otid === v[':o'] &&
                (row.appStoreSignedDate === undefined || row.appStoreSignedDate <= v[':d'])) ||
              (otid !== v[':o'] &&
                (row.appStore?.expiresAt < v[':now'] || row.appStore?.revoked === v[':true']));
            if (!ok) throw conditionFailed();
            row.appStore = v[':s'];
            row.appStoreOriginalTransactionId = v[':o'];
            row.appStoreSignedDate = v[':d'];
            return {};
          }
          throw new Error(`unexpected update ${input.UpdateExpression}`);
        }
        throw new Error(`unexpected command ${cmd.kind}`);
      }),
    },
  };
});

import {
  applyNotification,
  applyVerifiedTransaction,
  appStoreBlocksWebCheckout,
  getOrCreateAccountToken,
  purchaseRefusal,
  verifyTransaction,
} from '../../../src/services/appStoreBilling.js';
import { getHouseholdSubscription } from '../../../src/services/billing.js';
import { getEntitledPlan } from '../../../src/models/plans.js';
import type { AppStoreTransaction } from '../../../src/models/appStore.js';
import { makeChain, signJws, type ChainFixture } from '../../support/appleJwsFixture.js';

const NOW = new Date('2026-10-24T12:00:00.000Z');
const DAY = 86_400_000;

function household(id: string, extra: Record<string, unknown> = {}) {
  table.set(`HOUSEHOLD#${id}|METADATA`, {
    PK: `HOUSEHOLD#${id}`,
    SK: 'METADATA',
    planId: 'seedling',
    ...extra,
  });
}
const row = (id: string) => table.get(`HOUSEHOLD#${id}|METADATA`)!;

function tx(over: Partial<AppStoreTransaction> = {}): AppStoreTransaction {
  return {
    transactionId: '2000000001',
    originalTransactionId: '2000000000',
    bundleId: 'net.familygreenhouse.app',
    productId: 'net.familygreenhouse.app.garden.monthly',
    environment: 'Production',
    signedDate: NOW.getTime(),
    expiresDate: NOW.getTime() + 30 * DAY,
    ...over,
  };
}

beforeEach(() => {
  table.clear();
  household('hh-1');
  household('hh-2');
});

describe('getOrCreateAccountToken', () => {
  it('creates one UUID per household, with a lookup back to it, and reuses it', async () => {
    const first = await getOrCreateAccountToken('hh-1');
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(table.get(`APPSTORE_TOKEN#${first}|METADATA`)?.householdId).toBe('hh-1');
    expect(await getOrCreateAccountToken('hh-1')).toBe(first);
    expect(await getOrCreateAccountToken('hh-2')).not.toBe(first);
  });
});

describe('applyVerifiedTransaction', () => {
  it('binds a purchase to the household its token names and grants the tier', async () => {
    const token = await getOrCreateAccountToken('hh-1');
    const result = await applyVerifiedTransaction(
      tx({ appAccountToken: token.toUpperCase() }),
      null,
      'hh-1',
      NOW
    );
    expect(result).toMatchObject({ outcome: 'applied', householdId: 'hh-1', planId: 'garden' });
    expect(table.get('APPSTORE_TXN#2000000000|METADATA')?.householdId).toBe('hh-1');
    const sub = await getHouseholdSubscription('hh-1');
    expect(sub.appStore).toMatchObject({ planId: 'garden', environment: 'Production' });
    // The binding id stays internal: it is not part of the published shape.
    expect(JSON.stringify(sub)).not.toContain('2000000000');
    expect(getEntitledPlan(sub, NOW).id).toBe('garden');
  });

  it('refuses to move a subscription bound to another household', async () => {
    await applyVerifiedTransaction(tx(), null, 'hh-1', NOW);
    const restore = await applyVerifiedTransaction(tx(), null, 'hh-2', NOW);
    expect(restore.outcome).toBe('linked_elsewhere');
    expect(row('hh-2').appStore).toBeUndefined();
  });

  it('refuses a token that names another household', async () => {
    const token = await getOrCreateAccountToken('hh-1');
    const result = await applyVerifiedTransaction(
      tx({ appAccountToken: token }),
      null,
      'hh-2',
      NOW
    );
    expect(result.outcome).toBe('linked_elsewhere');
  });

  it('applies a renewal and refuses older data about the same subscription', async () => {
    await applyVerifiedTransaction(tx(), null, 'hh-1', NOW);
    const renewed = tx({
      transactionId: '2000000002',
      signedDate: NOW.getTime() + 30 * DAY,
      expiresDate: NOW.getTime() + 60 * DAY,
    });
    expect((await applyVerifiedTransaction(renewed, null, null, NOW)).outcome).toBe('applied');
    expect((await applyVerifiedTransaction(tx(), null, null, NOW)).outcome).toBe('stale');
    expect(row('hh-1').appStore.expiresAt).toBe(new Date(NOW.getTime() + 60 * DAY).toISOString());
  });

  it('refuses a second Apple subscription while the first is live, and allows it after', async () => {
    await applyVerifiedTransaction(tx(), null, 'hh-1', NOW);
    const second = tx({ originalTransactionId: '3000000000', transactionId: '3000000001' });
    expect((await applyVerifiedTransaction(second, null, 'hh-1', NOW)).outcome).toBe(
      'other_subscription'
    );
    const later = new Date(NOW.getTime() + 31 * DAY);
    const again = tx({
      originalTransactionId: '3000000000',
      transactionId: '3000000002',
      signedDate: later.getTime(),
      expiresDate: later.getTime() + 30 * DAY,
    });
    expect((await applyVerifiedTransaction(again, null, 'hh-1', later)).outcome).toBe('applied');
  });

  it('ends access on a refund', async () => {
    await applyVerifiedTransaction(tx(), null, 'hh-1', NOW);
    const refunded = tx({ signedDate: NOW.getTime() + DAY, revocationDate: NOW.getTime() + DAY });
    await applyVerifiedTransaction(refunded, null, null, NOW);
    const sub = await getHouseholdSubscription('hh-1');
    expect(getEntitledPlan(sub, new Date(NOW.getTime() + 2 * DAY)).id).toBe('seedling');
  });

  it('ignores another app, an unknown product and a refused environment', async () => {
    expect(
      (await applyVerifiedTransaction(tx({ bundleId: 'com.other' }), null, 'hh-1', NOW)).outcome
    ).toBe('wrong_app');
    expect(
      (await applyVerifiedTransaction(tx({ productId: 'x' }), null, 'hh-1', NOW)).outcome
    ).toBe('ignored');
    expect(
      (await applyVerifiedTransaction(tx({ environment: 'Xcode' }), null, 'hh-1', NOW)).outcome
    ).toBe('ignored');
    expect(row('hh-1').appStore).toBeUndefined();
  });

  it('cannot place a notification with no binding and no token', async () => {
    expect((await applyVerifiedTransaction(tx(), null, null, NOW)).outcome).toBe(
      'unknown_household'
    );
  });
});

describe('notifications and signed transactions', () => {
  let chain: ChainFixture;
  beforeAll(() => {
    chain = makeChain();
  }, 30_000);

  it('verifies the notification and the transaction inside it, then applies it', async () => {
    const token = await getOrCreateAccountToken('hh-2');
    const signedDate = Date.now();
    const signedTransactionInfo = signJws(chain, {
      ...tx({ appAccountToken: token, signedDate, expiresDate: signedDate + 30 * DAY }),
    });
    const signedPayload = signJws(chain, {
      notificationType: 'SUBSCRIBED',
      subtype: 'INITIAL_BUY',
      signedDate,
      data: {
        bundleId: 'net.familygreenhouse.app',
        appAppleId: 6812185914,
        environment: 'Production',
        signedTransactionInfo,
      },
    });
    const result = await applyNotification(
      signedPayload,
      { trustedRootsPem: [chain.rootPem] },
      new Date(signedDate)
    );
    expect(result).toMatchObject({
      outcome: 'applied',
      householdId: 'hh-2',
      notificationType: 'SUBSCRIBED',
    });
  });

  it('refuses a notification for another app id', async () => {
    const signedPayload = signJws(chain, {
      notificationType: 'SUBSCRIBED',
      signedDate: Date.now(),
      data: { bundleId: 'net.familygreenhouse.app', appAppleId: 1, environment: 'Production' },
    });
    const result = await applyNotification(signedPayload, { trustedRootsPem: [chain.rootPem] });
    expect(result.outcome).toBe('wrong_app');
  });

  it('refuses a signed transaction missing required fields', () => {
    const jws = signJws(chain, { productId: 'x', signedDate: Date.now() });
    expect(() => verifyTransaction(jws, { trustedRootsPem: [chain.rootPem] })).toThrow(/required/);
  });
});

describe('the double-billing guards', () => {
  it('refuses an App Store purchase for a household with a live Stripe subscription', async () => {
    household('hh-1', {
      planId: 'garden',
      stripeSubscriptionId: 'sub_1',
      subscriptionStatus: 'active',
    });
    expect(await purchaseRefusal('hh-1', 'greenhouse', NOW)).toBe('STRIPE_SUBSCRIPTION_ACTIVE');
  });

  it('refuses a second App Store purchase while one is active', async () => {
    await applyVerifiedTransaction(tx(), null, 'hh-1', NOW);
    expect(await purchaseRefusal('hh-1', 'greenhouse', NOW)).toBe('APP_STORE_SUBSCRIPTION_ACTIVE');
  });

  it('refuses a tier a lifetime purchase or a running gift already includes', async () => {
    household('hh-1', { lifetimePlanId: 'garden' });
    expect(await purchaseRefusal('hh-1', 'garden', NOW)).toBe('PLAN_ALREADY_INCLUDED');
    expect(await purchaseRefusal('hh-1', 'greenhouse', NOW)).toBeNull();
    household('hh-2', { giftPlanId: 'greenhouse', giftEndsAt: '2026-12-01T00:00:00.000Z' });
    expect(await purchaseRefusal('hh-2', 'garden', NOW)).toBe('PLAN_ALREADY_INCLUDED');
  });

  it('allows a household on its no-card trial to buy', async () => {
    household('hh-1', { noCardTrialEndsAt: '2026-11-01T00:00:00.000Z' });
    expect(await purchaseRefusal('hh-1', 'garden', NOW)).toBeNull();
  });

  it('blocks a web checkout while an App Store subscription is active, and not after', async () => {
    await applyVerifiedTransaction(tx(), null, 'hh-1', NOW);
    expect(await appStoreBlocksWebCheckout('hh-1', NOW)).toBe(true);
    expect(await appStoreBlocksWebCheckout('hh-1', new Date(NOW.getTime() + 31 * DAY))).toBe(false);
    expect(await appStoreBlocksWebCheckout('hh-2', NOW)).toBe(false);
  });
});
