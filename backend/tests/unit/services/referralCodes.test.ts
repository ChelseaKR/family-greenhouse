/**
 * Referral code storage (ADR 0029): get-or-create idempotency (including the
 * race where two requests for the same account both try to mint), the
 * lookup, and the referral-event list a referrer's settings panel reads.
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
  findReferralCodeOwner,
  getOrCreateReferralCode,
  listReferralEvents,
  recordReferralEvent,
} from '../../../src/services/referralCodes.js';

const cancelled = (codes: Array<string | undefined>) =>
  Object.assign(new Error('cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: codes.map((Code) => ({ Code })),
  });

describe('getOrCreateReferralCode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the existing code without minting when one is already on file', async () => {
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Item: {
        code: 'RF0000000001',
        householdId: 'hh-1',
        email: 'a@b.com',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const owner = await getOrCreateReferralCode({
      userId: 'user-1',
      householdId: 'hh-1',
      email: 'a@b.com',
    });
    expect(owner.code).toBe('RF0000000001');
    expect(dynamodb.send).toHaveBeenCalledTimes(1); // one Get, no mint
  });

  it('mints a new code, writing the lookup and the owner row in one transaction', async () => {
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({ Item: undefined }) // no existing code
      .mockResolvedValueOnce({}); // the mint transaction
    const owner = await getOrCreateReferralCode({
      userId: 'user-1',
      householdId: 'hh-1',
      email: 'A@B.com',
      now: new Date('2026-09-16T00:00:00.000Z'),
    });
    expect(owner.code).toMatch(/^RF[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(owner.referrerEmail).toBe('a@b.com'); // lower-cased for matching

    const tx = vi.mocked(dynamodb.send).mock.calls[1][0] as unknown as {
      kind: string;
      input: { TransactItems: Array<{ Put: Record<string, any> }> };
    };
    expect(tx.kind).toBe('TransactWrite');
    const [lookup, ownerRow] = tx.input.TransactItems.map((i) => i.Put);
    expect(lookup.Item).toMatchObject({
      PK: `REFERRALCODE#${owner.code}`,
      referrerUserId: 'user-1',
      referrerHouseholdId: 'hh-1',
    });
    expect(lookup.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(ownerRow.Item).toMatchObject({
      PK: 'USER#user-1',
      SK: 'REFERRAL_CODE',
      code: owner.code,
      householdId: 'hh-1',
    });
    expect(ownerRow.ConditionExpression).toBe('attribute_not_exists(PK)');
  });

  it('on a lost race against a concurrent call for the SAME account, re-reads and returns the winner (mints no second code)', async () => {
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({ Item: undefined }) // no existing code yet
      .mockRejectedValueOnce(cancelled([undefined, 'ConditionalCheckFailed'])) // lost the race on item [1]
      .mockResolvedValueOnce({
        Item: {
          code: 'RF9999999999',
          householdId: 'hh-1',
          email: 'a@b.com',
          createdAt: '2026-09-16T00:00:00.000Z',
        },
      }); // re-read finds the winner
    const owner = await getOrCreateReferralCode({
      userId: 'user-1',
      householdId: 'hh-1',
      email: 'a@b.com',
    });
    expect(owner.code).toBe('RF9999999999');
    expect(dynamodb.send).toHaveBeenCalledTimes(3);
  });
});

describe('findReferralCodeOwner', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null for an unknown code', async () => {
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: undefined });
    expect(await findReferralCodeOwner('RF0000000001')).toBeNull();
  });

  it('returns the owner for a known code', async () => {
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Item: {
        referrerUserId: 'user-1',
        referrerHouseholdId: 'hh-1',
        referrerEmail: 'a@b.com',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const owner = await findReferralCodeOwner('RF0000000001');
    expect(owner).toMatchObject({ referrerUserId: 'user-1', referrerHouseholdId: 'hh-1' });
  });
});

describe('recordReferralEvent / listReferralEvents', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records once and is idempotent on a retried duplicate', async () => {
    vi.mocked(dynamodb.send).mockResolvedValueOnce({});
    await recordReferralEvent('user-referrer', {
      referredHouseholdId: 'hh-new',
      signedUpAt: '2026-09-16T00:00:00.000Z',
      referredRewardStatus: 'granted',
      referrerRewardStatus: 'granted',
    });
    const tx = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      input: { TransactItems: Array<{ Put: Record<string, any> }> };
    };
    expect(tx.input.TransactItems[0].Put.Item).toMatchObject({
      PK: 'USER#user-referrer',
      SK: 'REFERRAL#hh-new',
    });

    // A retry hits the conditional check and must not throw.
    vi.mocked(dynamodb.send).mockRejectedValueOnce(cancelled(['ConditionalCheckFailed']));
    await expect(
      recordReferralEvent('user-referrer', {
        referredHouseholdId: 'hh-new',
        signedUpAt: '2026-09-16T00:00:00.000Z',
        referredRewardStatus: 'granted',
        referrerRewardStatus: 'granted',
      })
    ).resolves.toBeUndefined();
  });

  it('lists events newest first and skips malformed rows', async () => {
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Items: [
        {
          referredHouseholdId: 'hh-a',
          signedUpAt: '2026-09-01T00:00:00.000Z',
          referredRewardStatus: 'granted',
          referrerRewardStatus: 'granted',
        },
        {
          referredHouseholdId: 'hh-b',
          signedUpAt: '2026-09-10T00:00:00.000Z',
          referredRewardStatus: 'granted',
          referrerRewardStatus: 'skipped',
          referrerSkipReason: 'gift_active',
        },
        { referredHouseholdId: 'hh-broken' /* missing required fields */ },
      ],
    });
    const events = await listReferralEvents('user-referrer');
    expect(events).toHaveLength(2);
    expect(events[0].referredHouseholdId).toBe('hh-b'); // newest first
    expect(events[1].referredHouseholdId).toBe('hh-a');
  });
});
