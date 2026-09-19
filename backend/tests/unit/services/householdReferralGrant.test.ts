/**
 * `householdService.createHousehold`'s referral-grant parameter (ADR 0029).
 * Separate file from `householdService.test.ts` so the existing suite's
 * assertion that a plain call writes exactly 3 transact items stays
 * untouched and provably still true — this file is additive, not a rewrite.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  PutCommand: vi.fn(function (input) {
    return { input, kind: 'Put' };
  }),
  GetCommand: vi.fn(function (input) {
    return { input, kind: 'Get' };
  }),
  QueryCommand: vi.fn(function (input) {
    return { input, kind: 'Query' };
  }),
  DeleteCommand: vi.fn(function (input) {
    return { input, kind: 'Delete' };
  }),
  TransactWriteCommand: vi.fn(function (input) {
    return { input, kind: 'TransactWrite' };
  }),
  UpdateCommand: vi.fn(function (input) {
    return { input, kind: 'Update' };
  }),
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));

const cancelled = (codes: Array<string | undefined>) =>
  Object.assign(new Error('cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: codes.map((Code) => ({ Code })),
  });

const GRANT = {
  planId: 'garden' as const,
  endsAt: '2026-10-16T12:00:00.000Z',
  referrerUserId: 'user-referrer',
  referralCode: 'RF0000000001',
};

describe('createHousehold with a referral grant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('applies giftPlanId/giftEndsAt/giftSource to the household AND writes a 4th, one-per-account claim item', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { createHousehold } = await import('../../../src/services/householdService.js');
    vi.mocked(dynamodb.send).mockResolvedValue({});

    const result = await createHousehold(
      { name: 'New Household' },
      'user-new',
      'New User',
      'new@example.test',
      new Date('2026-09-16T12:00:00.000Z'),
      GRANT
    );
    expect(result).toMatchObject({ name: 'New Household', createdBy: 'user-new' });

    const calls = vi.mocked(dynamodb.send).mock.calls;
    expect(calls).toHaveLength(1); // succeeded on the first attempt — no fallback write
    const cmd = calls[0][0] as unknown as {
      kind: string;
      input: { TransactItems: Array<{ Put: { Item: Record<string, unknown> } }> };
    };
    expect(cmd.kind).toBe('TransactWrite');
    const items = cmd.input.TransactItems.map((t) => t.Put.Item);
    expect(items).toHaveLength(4);

    const householdItem = items.find((i) => i.entityType === 'Household');
    expect(householdItem).toMatchObject({
      giftPlanId: 'garden',
      giftEndsAt: '2026-10-16T12:00:00.000Z',
      giftSource: 'referral',
      // The trial fields still ride alongside it — a referral grant does not
      // replace the no-card trial, it just happens to raise the SAME tier
      // for longer (models/plans.ts's giftState/noCardTrialState interaction).
      noCardTrialEndsAt: expect.any(String),
    });

    const referralClaim = items.find((i) => i.entityType === 'ReferralRedeemedClaim');
    expect(referralClaim).toMatchObject({
      PK: 'USER#user-new',
      SK: 'REFERRAL_REDEEMED',
      referralCode: 'RF0000000001',
      referrerUserId: 'user-referrer',
    });
    expect(cmd.input.TransactItems.find((t) => t.Put.Item === referralClaim)?.Put).toMatchObject({
      ConditionExpression: 'attribute_not_exists(PK)',
    });

    const trialClaim = items.find((i) => i.entityType === 'NoCardTrialClaim');
    expect(trialClaim).toBeDefined(); // unaffected — still item [2]
  });

  it('falls back to a plain create (no trial, no referral) when the referral claim conflicts', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { createHousehold } = await import('../../../src/services/householdService.js');
    // Item [3] (the referral claim) is the one that lost the race.
    vi.mocked(dynamodb.send)
      .mockRejectedValueOnce(cancelled([undefined, undefined, undefined, 'ConditionalCheckFailed']))
      .mockResolvedValueOnce({});

    const result = await createHousehold(
      { name: 'New Household' },
      'user-new',
      'New User',
      'new@example.test',
      new Date('2026-09-16T12:00:00.000Z'),
      GRANT
    );
    expect(result).toMatchObject({ name: 'New Household' });
    // No trial began, so the response must not say one did.
    expect(result.noCardTrialEndsAt).toBeUndefined();

    const calls = vi.mocked(dynamodb.send).mock.calls;
    expect(calls).toHaveLength(2); // the failed attempt, then the fallback
    const fallback = calls[1][0] as unknown as {
      input: { TransactItems: Array<{ Put: { Item: Record<string, unknown> } }> };
    };
    expect(fallback.input.TransactItems).toHaveLength(2); // household + member only
    const householdItem = fallback.input.TransactItems[0].Put.Item;
    expect(householdItem.giftPlanId).toBeUndefined();
    expect(householdItem.noCardTrialEndsAt).toBeUndefined();
  });

  it('still propagates a genuinely unrelated transaction failure (not a claim conflict)', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { createHousehold } = await import('../../../src/services/householdService.js');
    vi.mocked(dynamodb.send).mockRejectedValueOnce(new Error('DynamoDB is unavailable'));

    await expect(
      createHousehold(
        { name: 'New Household' },
        'user-new',
        'New User',
        'new@example.test',
        new Date('2026-09-16T12:00:00.000Z'),
        GRANT
      )
    ).rejects.toThrow('DynamoDB is unavailable');
  });

  it('omitting the grant is byte-identical to the pre-referral 3-item transaction', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { createHousehold } = await import('../../../src/services/householdService.js');
    vi.mocked(dynamodb.send).mockResolvedValue({});

    await createHousehold({ name: 'Home' }, 'user-1', 'Alice', 'a@b.com');

    const cmd = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      input: { TransactItems: unknown[] };
    };
    expect(cmd.input.TransactItems).toHaveLength(3);
  });
});
