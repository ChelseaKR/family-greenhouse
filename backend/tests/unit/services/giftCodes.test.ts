/**
 * Gift storage (ADR 0028): the three rows a grant writes atomically, the
 * lookup by code, the two-row redemption transaction and its conditions, and
 * the buyer's list. DynamoDB is a recorder; every command's shape is
 * asserted, because the conditions ARE the idempotency and the safety.
 *
 * Synthetic fixtures only. No generated code is printed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  GetCommand: vi.fn(function (input) {
    return { input, kind: 'Get' };
  }),
  QueryCommand: vi.fn(function (input) {
    return { input, kind: 'Query' };
  }),
  TransactWriteCommand: vi.fn(function (input) {
    return { input, kind: 'TransactWrite' };
  }),
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));

import { dynamodb } from '../../../src/utils/dynamodb.js';
import {
  findGiftByCode,
  grantGiftPurchase,
  listGiftPurchases,
  redeemGift,
  type GiftRecord,
} from '../../../src/services/giftCodes.js';
import { hashGiftCode, normalizeGiftCode } from '../../../src/models/giftSubscriptions.js';

type Sent = { kind: string; input: Record<string, any> };
const sent = (i: number) => vi.mocked(dynamodb.send).mock.calls[i][0] as unknown as Sent;

const cancelled = (codes: string[]) =>
  Object.assign(new Error('cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: codes.map((Code) => ({ Code })),
  });

const GRANT = {
  stripeSessionId: 'cs_gift_1',
  planId: 'garden' as const,
  months: 3,
  buyerUserId: 'user-buyer',
  purchasedAt: '2026-09-13T12:00:00.000Z',
};

describe('grantGiftPurchase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes the gift, its lookup and the buyer’s copy in ONE transaction, keyed on the Session', async () => {
    vi.mocked(dynamodb.send).mockResolvedValueOnce({} as never);
    await expect(grantGiftPurchase(GRANT)).resolves.toBe(true);
    expect(vi.mocked(dynamodb.send)).toHaveBeenCalledTimes(1);
    const tx = sent(0);
    expect(tx.kind).toBe('TransactWrite');
    const items = tx.input.TransactItems as Array<{ Put: Record<string, any> }>;
    expect(items).toHaveLength(3);

    const [gift, lookup, buyer] = items.map((i) => i.Put);
    // The gift: idempotent by construction.
    expect(gift.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(gift.Item).toMatchObject({
      PK: 'GIFT#cs_gift_1',
      SK: 'METADATA',
      entityType: 'GiftSubscription',
      planId: 'garden',
      months: 3,
      buyerUserId: 'user-buyer',
      purchasedAt: '2026-09-13T12:00:00.000Z',
      redeemBy: '2027-09-13T12:00:00.000Z',
      redeemByEpoch: Math.floor(Date.parse('2027-09-13T12:00:00.000Z') / 1000),
    });
    // The gift row carries the hash and never the code.
    expect(gift.Item.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(gift.Item.code).toBeUndefined();
    // The lookup: hash → session, no code, no conditions of its own.
    expect(lookup.Item).toEqual({
      PK: `GIFTCODE#${gift.Item.codeHash}`,
      SK: 'METADATA',
      entityType: 'GiftCode',
      stripeSessionId: 'cs_gift_1',
    });
    // The buyer's copy: in the buyer's own partition, with the code.
    expect(buyer.Item).toMatchObject({
      PK: 'USER#user-buyer',
      SK: 'GIFT#cs_gift_1',
      entityType: 'GiftPurchase',
      planId: 'garden',
      months: 3,
      redeemBy: '2027-09-13T12:00:00.000Z',
    });
    expect(buyer.Item.code).toMatch(/^FG[0-9A-HJKMNP-TV-Z]{16}$/);
    expect(hashGiftCode(buyer.Item.code)).toBe(gift.Item.codeHash);
    expect(normalizeGiftCode(buyer.Item.code)).toBe(buyer.Item.code);
    for (const put of [gift, lookup, buyer]) expect(put.TableName).toBe('test-table');
  });

  it('creates nothing — and mints no second code — when a gift for this Session already exists', async () => {
    vi.mocked(dynamodb.send).mockRejectedValueOnce(
      cancelled(['ConditionalCheckFailed', 'None', 'None'])
    );
    await expect(grantGiftPurchase(GRANT)).resolves.toBe(false);
  });

  it('propagates any other failure so the webhook retries', async () => {
    vi.mocked(dynamodb.send).mockRejectedValueOnce(new Error('throttled'));
    await expect(grantGiftPurchase(GRANT)).rejects.toThrow('throttled');
    vi.mocked(dynamodb.send).mockRejectedValueOnce(cancelled(['None', 'None', 'None']));
    await expect(grantGiftPurchase(GRANT)).rejects.toThrow('cancelled');
  });

  it('refuses an unreadable purchase time rather than computing a redeem-by from NaN', async () => {
    await expect(grantGiftPurchase({ ...GRANT, purchasedAt: 'yesterday' })).rejects.toThrow(
      /invalid purchase time/
    );
    expect(vi.mocked(dynamodb.send)).not.toHaveBeenCalled();
  });
});

const CODE = 'FG0123456789ABCDEF';
const HASH = hashGiftCode(CODE);
const giftItem = (over: Record<string, unknown> = {}) => ({
  PK: 'GIFT#cs_gift_1',
  SK: 'METADATA',
  stripeSessionId: 'cs_gift_1',
  planId: 'garden',
  months: 3,
  buyerUserId: 'user-buyer',
  codeHash: HASH,
  purchasedAt: '2026-09-13T12:00:00.000Z',
  redeemBy: '2027-09-13T12:00:00.000Z',
  redeemByEpoch: Math.floor(Date.parse('2027-09-13T12:00:00.000Z') / 1000),
  ...over,
});

describe('findGiftByCode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves hash → session → gift, and reads the gift row back typed', async () => {
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({ Item: { stripeSessionId: 'cs_gift_1' } } as never)
      .mockResolvedValueOnce({ Item: giftItem() } as never);
    const gift = await findGiftByCode(CODE);
    expect(sent(0).input.Key).toEqual({ PK: `GIFTCODE#${HASH}`, SK: 'METADATA' });
    expect(sent(1).input.Key).toEqual({ PK: 'GIFT#cs_gift_1', SK: 'METADATA' });
    expect(gift).toMatchObject({ stripeSessionId: 'cs_gift_1', planId: 'garden', months: 3 });
    expect(gift?.redeemedAt).toBeUndefined();
  });

  it('is null for an unknown code, and never reads a gift row for it', async () => {
    vi.mocked(dynamodb.send).mockResolvedValueOnce({} as never);
    await expect(findGiftByCode(CODE)).resolves.toBeNull();
    expect(vi.mocked(dynamodb.send)).toHaveBeenCalledTimes(1);
  });

  it('is null when the gift row is missing, malformed, or recorded under a different hash', async () => {
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({ Item: { stripeSessionId: 'cs_gift_1' } } as never)
      .mockResolvedValueOnce({} as never);
    await expect(findGiftByCode(CODE)).resolves.toBeNull();
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({ Item: { stripeSessionId: 'cs_gift_1' } } as never)
      .mockResolvedValueOnce({ Item: giftItem({ planId: 'seedling' }) } as never);
    await expect(findGiftByCode(CODE)).resolves.toBeNull();
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({ Item: { stripeSessionId: 'cs_gift_1' } } as never)
      .mockResolvedValueOnce({ Item: giftItem({ codeHash: 'f'.repeat(64) }) } as never);
    await expect(findGiftByCode(CODE)).resolves.toBeNull();
  });
});

describe('redeemGift', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const gift: GiftRecord = {
    stripeSessionId: 'cs_gift_1',
    planId: 'garden',
    months: 3,
    buyerUserId: 'user-buyer',
    codeHash: HASH,
    purchasedAt: '2026-09-13T12:00:00.000Z',
    redeemBy: '2027-09-13T12:00:00.000Z',
    redeemByEpoch: Math.floor(Date.parse('2027-09-13T12:00:00.000Z') / 1000),
  };
  const now = new Date('2026-10-01T09:30:00.000Z');
  const endsAt = new Date('2027-01-01T09:30:00.000Z');
  const live = ['active', 'trialing', 'past_due', 'unpaid', 'paused'];

  it('consumes the code and places the gift on the household in one transaction, each half conditioned', async () => {
    vi.mocked(dynamodb.send).mockResolvedValueOnce({} as never);
    await expect(
      redeemGift({ gift, householdId: 'hh-9', endsAt, now, liveSubscriptionStatuses: live })
    ).resolves.toBe('redeemed');
    const tx = sent(0);
    expect(tx.kind).toBe('TransactWrite');
    const [code, household] = (
      tx.input.TransactItems as Array<{ Update: Record<string, any> }>
    ).map((i) => i.Update);

    expect(code.Key).toEqual({ PK: 'GIFT#cs_gift_1', SK: 'METADATA' });
    expect(code.ConditionExpression).toBe(
      'attribute_exists(PK) AND attribute_not_exists(redeemedAt) AND redeemByEpoch > :nowEpoch AND codeHash = :hash'
    );
    expect(code.ExpressionAttributeValues).toEqual({
      ':now': '2026-10-01T09:30:00.000Z',
      ':hh': 'hh-9',
      ':endsAt': '2027-01-01T09:30:00.000Z',
      ':nowEpoch': Math.floor(now.getTime() / 1000),
      ':hash': HASH,
    });

    expect(household.Key).toEqual({ PK: 'HOUSEHOLD#hh-9', SK: 'METADATA' });
    expect(household.UpdateExpression).toBe(
      'SET giftPlanId = :plan, giftEndsAt = :endsAt, giftStripeSessionId = :sid, giftRedeemedAt = :now'
    );
    // No gift running, and no live subscription: absent id, or a recorded
    // status outside the live set. An id with NO status is live (fails closed).
    expect(household.ConditionExpression).toBe(
      'attribute_exists(PK) AND (attribute_not_exists(giftEndsAt) OR giftEndsAt < :now) AND ' +
        '(attribute_not_exists(stripeSubscriptionId) OR (attribute_exists(subscriptionStatus) AND NOT (subscriptionStatus IN (:live0, :live1, :live2, :live3, :live4))))'
    );
    expect(household.ExpressionAttributeValues).toEqual({
      ':plan': 'garden',
      ':endsAt': '2027-01-01T09:30:00.000Z',
      ':sid': 'cs_gift_1',
      ':now': '2026-10-01T09:30:00.000Z',
      ':live0': 'active',
      ':live1': 'trialing',
      ':live2': 'past_due',
      ':live3': 'unpaid',
      ':live4': 'paused',
    });
    // Nothing else on the household row is touched: not the plan, not the
    // subscription, not the trial.
    expect(household.UpdateExpression).not.toMatch(/planId =|subscriptionStatus|noCardTrial/);
  });

  it('reports which half refused, and consumes nothing when either does', async () => {
    vi.mocked(dynamodb.send).mockRejectedValueOnce(cancelled(['ConditionalCheckFailed', 'None']));
    await expect(
      redeemGift({ gift, householdId: 'hh-9', endsAt, now, liveSubscriptionStatuses: live })
    ).resolves.toBe('code_conflict');
    vi.mocked(dynamodb.send).mockRejectedValueOnce(cancelled(['None', 'ConditionalCheckFailed']));
    await expect(
      redeemGift({ gift, householdId: 'hh-9', endsAt, now, liveSubscriptionStatuses: live })
    ).resolves.toBe('household_conflict');
  });

  it('propagates an infrastructure failure', async () => {
    vi.mocked(dynamodb.send).mockRejectedValueOnce(new Error('throttled'));
    await expect(
      redeemGift({ gift, householdId: 'hh-9', endsAt, now, liveSubscriptionStatuses: live })
    ).rejects.toThrow('throttled');
  });
});

describe('listGiftPurchases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const now = new Date('2026-10-01T00:00:00.000Z');
  const buyerRow = (sid: string, purchasedAt: string) => ({
    PK: 'USER#user-buyer',
    SK: `GIFT#${sid}`,
    stripeSessionId: sid,
    code: CODE,
    planId: 'garden',
    months: 3,
    purchasedAt,
    redeemBy: '2027-09-13T12:00:00.000Z',
  });

  it('lists the buyer’s gifts newest first with the display code and each one’s status', async () => {
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({
        Items: [
          buyerRow('cs_old', '2026-08-01T00:00:00.000Z'),
          buyerRow('cs_new', '2026-09-13T12:00:00.000Z'),
          buyerRow('cs_used', '2026-09-01T00:00:00.000Z'),
          buyerRow('cs_late', '2026-07-01T00:00:00.000Z'),
        ],
      } as never)
      // One Get per row, in row order.
      .mockResolvedValueOnce({ Item: giftItem({ stripeSessionId: 'cs_old' }) } as never)
      .mockResolvedValueOnce({ Item: giftItem({ stripeSessionId: 'cs_new' }) } as never)
      .mockResolvedValueOnce({
        Item: giftItem({
          stripeSessionId: 'cs_used',
          redeemedAt: '2026-09-02T00:00:00.000Z',
          giftEndsAt: '2026-12-02T00:00:00.000Z',
        }),
      } as never)
      .mockResolvedValueOnce({
        Item: giftItem({
          stripeSessionId: 'cs_late',
          redeemBy: '2026-09-30T00:00:00.000Z',
          redeemByEpoch: Math.floor(Date.parse('2026-09-30T00:00:00.000Z') / 1000),
        }),
      } as never);
    const list = await listGiftPurchases('user-buyer', now);
    expect(sent(0).kind).toBe('Query');
    expect(sent(0).input.ExpressionAttributeValues).toEqual({
      ':pk': 'USER#user-buyer',
      ':sk': 'GIFT#',
    });
    expect(list.map((g) => [g.stripeSessionId, g.status])).toEqual([
      ['cs_new', 'unredeemed'],
      ['cs_used', 'redeemed'],
      ['cs_old', 'unredeemed'],
      ['cs_late', 'expired'],
    ]);
    expect(list[0].code).toBe('FG-0123-4567-89AB-CDEF');
    expect(list[1]).toMatchObject({
      redeemedAt: '2026-09-02T00:00:00.000Z',
      giftEndsAt: '2026-12-02T00:00:00.000Z',
    });
  });

  it('marks a gift whose row could not be read as unknown — the code is still shown, the status is not guessed', async () => {
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({ Items: [buyerRow('cs_1', '2026-09-13T12:00:00.000Z')] } as never)
      .mockRejectedValueOnce(new Error('throttled'));
    const list = await listGiftPurchases('user-buyer', now);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: 'unknown', code: 'FG-0123-4567-89AB-CDEF' });
  });

  it('propagates a failed read of the buyer’s own rows rather than answering with an empty list', async () => {
    vi.mocked(dynamodb.send).mockRejectedValueOnce(new Error('throttled'));
    await expect(listGiftPurchases('user-buyer', now)).rejects.toThrow('throttled');
  });

  it('skips a malformed buyer row', async () => {
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Items: [{ PK: 'USER#user-buyer', SK: 'GIFT#x', stripeSessionId: 'x' }],
    } as never);
    await expect(listGiftPurchases('user-buyer', now)).resolves.toEqual([]);
  });
});
