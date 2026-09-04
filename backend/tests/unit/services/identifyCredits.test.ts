import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  PutCommand: vi.fn(function (i) {
    return { input: i, kind: 'Put' };
  }),
  QueryCommand: vi.fn(function (i) {
    return { input: i, kind: 'Query' };
  }),
  UpdateCommand: vi.fn(function (i) {
    return { input: i, kind: 'Update' };
  }),
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test',
}));

import { dynamodb } from '../../../src/utils/dynamodb.js';

type Sent = { kind: string; input: Record<string, any> };
const sent = (i: number) => vi.mocked(dynamodb.send).mock.calls[i][0] as unknown as Sent;

const NOW = new Date('2026-09-03T12:00:00Z');
const nowEpoch = Math.floor(NOW.getTime() / 1000);
const DAY = 24 * 60 * 60;

function pack(over: Partial<Record<string, unknown>> = {}) {
  return {
    PK: 'HOUSEHOLD#hh-1',
    SK: 'IDCREDIT#cs_a',
    remaining: 5,
    expiresAt: new Date((nowEpoch + 100 * DAY) * 1000).toISOString(),
    expiresAtEpoch: nowEpoch + 100 * DAY,
    ...over,
  };
}

const conditional = () =>
  Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });

describe('identifyCredits service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('grantCreditPack', () => {
    it('creates one pack row keyed by the Stripe session, expiring validityDays after purchase', async () => {
      vi.mocked(dynamodb.send).mockResolvedValueOnce({} as never);
      const { grantCreditPack } = await import('../../../src/services/identifyCredits.js');
      const granted = await grantCreditPack({
        householdId: 'hh-1',
        stripeSessionId: 'cs_123',
        credits: 20,
        purchasedAt: '2026-09-03T12:00:00.000Z',
        validityDays: 365,
      });
      expect(granted).toBe(true);
      const cmd = sent(0);
      expect(cmd.kind).toBe('Put');
      // The session id IS the key: a second delivery cannot create a second pack.
      expect(cmd.input.ConditionExpression).toBe('attribute_not_exists(PK)');
      expect(cmd.input.Item).toMatchObject({
        PK: 'HOUSEHOLD#hh-1',
        SK: 'IDCREDIT#cs_123',
        entityType: 'IdentifyCreditPack',
        stripeSessionId: 'cs_123',
        granted: 20,
        remaining: 20,
        purchasedAt: '2026-09-03T12:00:00.000Z',
        expiresAtEpoch: nowEpoch + 365 * DAY,
        expiresAt: new Date((nowEpoch + 365 * DAY) * 1000).toISOString(),
      });
      // Swept a month after expiry; never before it.
      expect(cmd.input.Item.ttl).toBe(nowEpoch + 365 * DAY + 30 * DAY);
    });

    it('grants NOTHING the second time the same session is delivered', async () => {
      vi.mocked(dynamodb.send).mockRejectedValueOnce(conditional() as never);
      const { grantCreditPack } = await import('../../../src/services/identifyCredits.js');
      await expect(
        grantCreditPack({
          householdId: 'hh-1',
          stripeSessionId: 'cs_123',
          credits: 20,
          purchasedAt: '2026-09-03T12:00:00.000Z',
          validityDays: 365,
        })
      ).resolves.toBe(false);
    });

    it('propagates any other write failure so the webhook answers 5xx and Stripe retries', async () => {
      vi.mocked(dynamodb.send).mockRejectedValueOnce(new Error('throttled') as never);
      const { grantCreditPack } = await import('../../../src/services/identifyCredits.js');
      await expect(
        grantCreditPack({
          householdId: 'hh-1',
          stripeSessionId: 'cs_123',
          credits: 20,
          purchasedAt: '2026-09-03T12:00:00.000Z',
          validityDays: 365,
        })
      ).rejects.toThrow('throttled');
    });

    it.each([0, -1, 1.5])(
      'refuses a %s-credit grant before touching the table',
      async (credits) => {
        const { grantCreditPack } = await import('../../../src/services/identifyCredits.js');
        await expect(
          grantCreditPack({
            householdId: 'hh-1',
            stripeSessionId: 'cs_123',
            credits,
            purchasedAt: '2026-09-03T12:00:00.000Z',
            validityDays: 365,
          })
        ).rejects.toThrow(/non-positive/);
        expect(dynamodb.send).not.toHaveBeenCalled();
      }
    );
  });

  describe('getCreditBalance', () => {
    it('sums every unexpired pack with credits and reports the soonest expiry', async () => {
      const soon = pack({
        SK: 'IDCREDIT#cs_b',
        remaining: 3,
        expiresAtEpoch: nowEpoch + 10 * DAY,
        expiresAt: 'soon',
      });
      const later = pack({ SK: 'IDCREDIT#cs_a', remaining: 5 });
      vi.mocked(dynamodb.send).mockResolvedValueOnce({ Items: [later, soon] } as never);
      const { getCreditBalance } = await import('../../../src/services/identifyCredits.js');
      await expect(getCreditBalance('hh-1', NOW)).resolves.toEqual({
        remaining: 8,
        expiresAt: 'soon',
      });
      const cmd = sent(0);
      expect(cmd.kind).toBe('Query');
      expect(cmd.input.KeyConditionExpression).toBe('PK = :pk AND begins_with(SK, :sk)');
      expect(cmd.input.ExpressionAttributeValues).toEqual({
        ':pk': 'HOUSEHOLD#hh-1',
        ':sk': 'IDCREDIT#',
      });
    });

    it('ignores expired packs and packs already at zero', async () => {
      vi.mocked(dynamodb.send).mockResolvedValueOnce({
        Items: [
          pack({ SK: 'IDCREDIT#cs_expired', remaining: 9, expiresAtEpoch: nowEpoch - 1 }),
          pack({ SK: 'IDCREDIT#cs_spent', remaining: 0 }),
        ],
      } as never);
      const { getCreditBalance } = await import('../../../src/services/identifyCredits.js');
      await expect(getCreditBalance('hh-1', NOW)).resolves.toEqual({
        remaining: 0,
        expiresAt: null,
      });
    });

    it('a household with no packs is a real zero', async () => {
      vi.mocked(dynamodb.send).mockResolvedValueOnce({ Items: [] } as never);
      const { getCreditBalance } = await import('../../../src/services/identifyCredits.js');
      await expect(getCreditBalance('hh-1', NOW)).resolves.toEqual({
        remaining: 0,
        expiresAt: null,
      });
    });

    it('a FAILED read is null — unknown — never 0', async () => {
      vi.mocked(dynamodb.send).mockRejectedValueOnce(new Error('throttled') as never);
      const { getCreditBalance } = await import('../../../src/services/identifyCredits.js');
      await expect(getCreditBalance('hh-1', NOW)).resolves.toBeNull();
    });
  });

  describe('consumeCredit', () => {
    it('spends one credit from the soonest-expiring pack with a conditional decrement', async () => {
      const soon = pack({
        SK: 'IDCREDIT#cs_b',
        remaining: 1,
        expiresAtEpoch: nowEpoch + 10 * DAY,
        expiresAt: 'soon',
      });
      const later = pack({ SK: 'IDCREDIT#cs_a', remaining: 5, expiresAt: 'later' });
      vi.mocked(dynamodb.send)
        .mockResolvedValueOnce({ Items: [later, soon] } as never)
        .mockResolvedValueOnce({ Attributes: { remaining: 0 } } as never);
      const { consumeCredit } = await import('../../../src/services/identifyCredits.js');
      // The spent pack is now empty, so what is left is the later pack.
      await expect(consumeCredit('hh-1', NOW)).resolves.toEqual({
        remaining: 5,
        expiresAt: 'later',
      });
      const update = sent(1);
      expect(update.kind).toBe('Update');
      expect(update.input.Key).toEqual({ PK: 'HOUSEHOLD#hh-1', SK: 'IDCREDIT#cs_b' });
      expect(update.input.UpdateExpression).toBe('SET #remaining = #remaining - :one');
      expect(update.input.ConditionExpression).toBe(
        '#remaining > :zero AND #expiresAtEpoch > :now'
      );
      expect(update.input.ExpressionAttributeValues).toEqual({
        ':one': 1,
        ':zero': 0,
        ':now': nowEpoch,
      });
    });

    it('moves to the next pack when a concurrent spend emptied the first', async () => {
      const soon = pack({
        SK: 'IDCREDIT#cs_b',
        remaining: 1,
        expiresAtEpoch: nowEpoch + 10 * DAY,
        expiresAt: 'soon',
      });
      const later = pack({ SK: 'IDCREDIT#cs_a', remaining: 5, expiresAt: 'later' });
      vi.mocked(dynamodb.send)
        .mockResolvedValueOnce({ Items: [soon, later] } as never)
        .mockRejectedValueOnce(conditional() as never)
        .mockResolvedValueOnce({ Attributes: { remaining: 4 } } as never);
      const { consumeCredit } = await import('../../../src/services/identifyCredits.js');
      await expect(consumeCredit('hh-1', NOW)).resolves.toEqual({
        remaining: 4,
        expiresAt: 'later',
      });
      expect(sent(2).input.Key.SK).toBe('IDCREDIT#cs_a');
    });

    it('throws IdentifyCreditsExhaustedError when no unexpired pack has a credit', async () => {
      vi.mocked(dynamodb.send).mockResolvedValueOnce({
        Items: [
          pack({ remaining: 0 }),
          pack({ SK: 'IDCREDIT#cs_old', remaining: 4, expiresAtEpoch: nowEpoch - 5 }),
        ],
      } as never);
      const { consumeCredit, IdentifyCreditsExhaustedError } =
        await import('../../../src/services/identifyCredits.js');
      await expect(consumeCredit('hh-1', NOW)).rejects.toBeInstanceOf(
        IdentifyCreditsExhaustedError
      );
      expect(dynamodb.send).toHaveBeenCalledTimes(1);
    });

    it('is exhausted, not errored, when every candidate loses its conditional write', async () => {
      vi.mocked(dynamodb.send)
        .mockResolvedValueOnce({ Items: [pack({ remaining: 1 })] } as never)
        .mockRejectedValueOnce(conditional() as never);
      const { consumeCredit, IdentifyCreditsExhaustedError } =
        await import('../../../src/services/identifyCredits.js');
      await expect(consumeCredit('hh-1', NOW)).rejects.toBeInstanceOf(
        IdentifyCreditsExhaustedError
      );
    });

    it('fails CLOSED on a read failure — propagates rather than reporting an empty pack', async () => {
      vi.mocked(dynamodb.send).mockRejectedValueOnce(new Error('throttled') as never);
      const { consumeCredit, IdentifyCreditsExhaustedError } =
        await import('../../../src/services/identifyCredits.js');
      const err = await consumeCredit('hh-1', NOW).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(IdentifyCreditsExhaustedError);
      expect((err as Error).message).toBe('throttled');
    });

    it('propagates a non-conditional write failure', async () => {
      vi.mocked(dynamodb.send)
        .mockResolvedValueOnce({ Items: [pack({ remaining: 3 })] } as never)
        .mockRejectedValueOnce(new Error('write throttled') as never);
      const { consumeCredit } = await import('../../../src/services/identifyCredits.js');
      await expect(consumeCredit('hh-1', NOW)).rejects.toThrow('write throttled');
    });
  });
});
