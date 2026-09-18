/**
 * The DynamoDB half of the household audit log (#675): the append, what a
 * failed append leaves behind, the Stripe producer, and paging.
 */
import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  PutCommand: vi.fn(function (input) {
    return { input, kind: 'Put' };
  }),
  QueryCommand: vi.fn(function (input) {
    return { input, kind: 'Query' };
  }),
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));
vi.mock('../../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { dynamodb } from '../../../src/utils/dynamodb.js';
import { logger } from '../../../src/utils/logger.js';
import {
  HOUSEHOLD_AUDIT_WRITE_FAILED,
  __resetAuditGapsForTests,
  listHouseholdAudit,
  recordBillingTransition,
  recordHouseholdAudit,
} from '../../../src/services/householdAudit.js';
import { auditMemberRef } from '../../../src/models/householdAudit.js';

const HH = 'hh-1';
const ADA = 'a1f6c0a2-0000-4000-8000-000000000001';
const send = vi.mocked(dynamodb.send);

type Cmd = { kind: string; input: Record<string, unknown> };
const puts = (): Array<Record<string, unknown>> =>
  send.mock.calls
    .map(([c]) => c as unknown as Cmd)
    .filter((c) => c.kind === 'Put')
    .map((c) => c.input.Item as Record<string, unknown>);

beforeEach(() => {
  vi.clearAllMocks();
  send.mockReset();
  __resetAuditGapsForTests();
});

describe('recordHouseholdAudit', () => {
  it('Puts one row under attribute_not_exists, so nothing can overwrite an entry', async () => {
    send.mockResolvedValueOnce({} as never);
    await recordHouseholdAudit({
      householdId: HH,
      kind: 'member.joined',
      actor: { type: 'member', userId: ADA },
      details: { role: 'member' },
    });
    const cmd = send.mock.calls[0][0] as unknown as Cmd;
    expect(cmd.kind).toBe('Put');
    expect(cmd.input.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(cmd.input.Item).toMatchObject({
      PK: `HOUSEHOLD#${HH}#AUDIT`,
      kind: 'member.joined',
      actorRef: auditMemberRef(HH, ADA),
      details: { role: 'member' },
    });
  });

  it('resolves when DynamoDB fails — the mutation it describes has already happened', async () => {
    send.mockRejectedValueOnce(new Error('ProvisionedThroughputExceededException'));
    await expect(
      recordHouseholdAudit({
        householdId: HH,
        kind: 'api_key.revoked',
        actor: { type: 'member', userId: ADA },
        details: { keyId: ADA },
      })
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ householdId: HH, kind: 'api_key.revoked' }),
      HOUSEHOLD_AUDIT_WRITE_FAILED
    );
  });

  it('marks the next entry for that household gapBefore, once, and not other households', async () => {
    send.mockRejectedValueOnce(new Error('throttled'));
    const entry = {
      kind: 'kiosk_link.revoked' as const,
      actor: { type: 'member' as const, userId: ADA },
      details: { count: 1 },
    };
    await recordHouseholdAudit({ householdId: HH, ...entry });

    send.mockResolvedValue({} as never);
    await recordHouseholdAudit({ householdId: 'hh-other', ...entry });
    await recordHouseholdAudit({ householdId: HH, ...entry });
    await recordHouseholdAudit({ householdId: HH, ...entry });

    // puts() includes the attempt that failed.
    const [failed, other, first, second] = puts();
    expect(failed).not.toHaveProperty('gapBefore');
    expect(other.householdId).toBe('hh-other');
    expect(other).not.toHaveProperty('gapBefore');
    expect(first.gapBefore).toBe(true);
    expect(second).not.toHaveProperty('gapBefore');
  });

  it('keeps the gap until a write actually lands', async () => {
    const entry = {
      householdId: HH,
      kind: 'kiosk_link.revoked' as const,
      actor: { type: 'member' as const, userId: ADA },
      details: { count: 1 },
    };
    send.mockRejectedValueOnce(new Error('throttled'));
    await recordHouseholdAudit(entry);
    send.mockRejectedValueOnce(new Error('throttled again'));
    await recordHouseholdAudit(entry);
    send.mockResolvedValueOnce({} as never);
    await recordHouseholdAudit(entry);

    // Three attempts: the first failed with no gap to carry, the second failed
    // carrying it, and the third landed carrying it.
    const items = puts();
    expect(items).toHaveLength(3);
    expect(items[0]).not.toHaveProperty('gapBefore');
    expect(items[1].gapBefore).toBe(true);
    expect(items[2].gapBefore).toBe(true);
  });

  it('NEGATIVE CONTROL: a token a producer smuggles in never reaches the row or the log', async () => {
    send.mockResolvedValue({} as never);
    const token = randomBytes(32).toString('hex');
    const input = {
      householdId: HH,
      kind: 'sitter_link.created',
      actor: { type: 'member', userId: ADA },
      // One as an extra key, one as the value of an allowed key.
      details: { linkId: token, startsAt: '2026-09-18T12:00:00.000Z', expiresAt: token, token },
    } as unknown as Parameters<typeof recordHouseholdAudit>[0];
    // The sabotage landed: the token is in what the producer passed.
    expect(JSON.stringify(input)).toContain(token);

    await recordHouseholdAudit(input);

    const [item] = puts();
    expect(item.kind).toBe('sitter_link.created');
    expect(item.details).toEqual({ startsAt: '2026-09-18T12:00:00.000Z' });
    expect(JSON.stringify(item)).not.toContain(token);
    // The drop is reported by key name only.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ dropped: ['linkId', 'expiresAt', 'token'] }),
      'household_audit.detail_dropped'
    );
    const everyLogArg = JSON.stringify([
      vi.mocked(logger.warn).mock.calls,
      vi.mocked(logger.error).mock.calls,
      vi.mocked(logger.info).mock.calls,
    ]);
    expect(everyLogArg).not.toContain(token);
  });
});

describe('recordBillingTransition', () => {
  /** A Stripe-shaped `customer.subscription.updated` carrying everything the
   *  log must not keep. */
  function subscriptionUpdated(previousStatus: string) {
    return {
      id: 'evt_1PzQ',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_1PzQabcdef',
          customer: 'cus_Qx9YabcdefGH',
          metadata: { householdId: HH },
          latest_invoice: 'in_1PzQabcdef',
          customer_email: 'payer@example.invalid',
          default_payment_method: { card: { last4: '0341', brand: 'visa', exp_year: 2031 } },
        },
        previous_attributes: { status: previousStatus },
      },
    };
  }

  it('writes a payment_failed entry as Stripe, from the recorded status', async () => {
    send.mockResolvedValue({} as never);
    await recordBillingTransition(HH, subscriptionUpdated('active'), {
      planId: 'garden',
      status: 'past_due',
    });
    const [item] = puts();
    expect(item).toMatchObject({
      kind: 'billing.payment_failed',
      actorType: 'stripe',
      details: { plan: 'garden', status: 'past_due' },
    });
    expect(item).not.toHaveProperty('actorRef');
  });

  it('writes payment_recovered when a past_due subscription goes active', async () => {
    send.mockResolvedValue({} as never);
    await recordBillingTransition(HH, subscriptionUpdated('past_due'), {
      planId: 'garden',
      status: 'active',
    });
    expect(puts().map((i) => i.kind)).toEqual(['billing.payment_recovered']);
  });

  it('NEGATIVE CONTROL: no customer, invoice, subscription id, email or card detail lands', async () => {
    send.mockResolvedValue({} as never);
    const event = subscriptionUpdated('active');
    const serialized = JSON.stringify(event);
    for (const secret of ['cus_Qx9YabcdefGH', 'payer@example.invalid', '0341', 'sub_1PzQabcdef']) {
      expect(serialized).toContain(secret);
    }

    await recordBillingTransition(HH, event, { planId: 'garden', status: 'past_due' });

    const stored = JSON.stringify(puts());
    expect(stored).toContain('billing.payment_failed');
    for (const secret of [
      'cus_Qx9YabcdefGH',
      'payer@example.invalid',
      '0341',
      'visa',
      'sub_1PzQabcdef',
      'in_1PzQabcdef',
      'evt_1PzQ',
    ]) {
      expect(stored).not.toContain(secret);
    }
  });

  it('writes nothing for an event that moved neither plan nor payment state', async () => {
    await recordBillingTransition(
      HH,
      { type: 'customer.subscription.updated', data: { previous_attributes: { metadata: {} } } },
      { planId: 'garden', status: 'active' }
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('resolves when the write fails', async () => {
    send.mockRejectedValue(new Error('down'));
    await expect(
      recordBillingTransition(HH, subscriptionUpdated('active'), {
        planId: 'garden',
        status: 'past_due',
      })
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'billing.payment_failed' }),
      HOUSEHOLD_AUDIT_WRITE_FAILED
    );
  });
});

describe('listHouseholdAudit', () => {
  /**
   * A partition of `n` rows behind a fake that honours Limit and
   * ExclusiveStartKey the way DynamoDB does: newest first, LastEvaluatedKey
   * whenever the page filled.
   */
  function partition(n: number, householdId = HH) {
    const base = Date.parse('2026-09-01T00:00:00.000Z');
    const rows = Array.from({ length: n }, (_, i) => {
      const at = new Date(base + i * 1000).toISOString();
      return {
        PK: `HOUSEHOLD#${householdId}#AUDIT`,
        SK: `AUDIT#${at}#e${String(i).padStart(4, '0')}`,
        id: `e${i}`,
        ttl: 4_102_444_800, // 2100
      };
    });
    send.mockImplementation(async (raw) => {
      const { input } = raw as unknown as Cmd;
      const values = input.ExpressionAttributeValues as Record<string, string>;
      const start = input.ExclusiveStartKey as { PK: string; SK: string } | undefined;
      const newestFirst = rows
        .filter((r) => r.PK === values[':pk'] && r.SK.startsWith(values[':prefix']))
        .sort((a, b) => (a.SK < b.SK ? 1 : -1))
        .filter((r) => !start || r.SK < start.SK);
      const page = newestFirst.slice(0, input.Limit as number);
      const last = page[page.length - 1];
      return {
        Items: page,
        ...(page.length === input.Limit && last
          ? { LastEvaluatedKey: { PK: last.PK, SK: last.SK } }
          : {}),
      } as never;
    });
    return rows;
  }

  it('pages a 1,000-entry log: every entry exactly once, newest first, ending in a null cursor', async () => {
    const rows = partition(1000);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<typeof listHouseholdAudit>> = await listHouseholdAudit(HH, {
        limit: 100,
        cursor,
      });
      seen.push(...page.items.map((i) => String(i.SK)));
      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(20);
    } while (cursor);

    expect(seen).toHaveLength(1000);
    expect(new Set(seen).size).toBe(1000);
    expect(seen).toEqual(
      rows
        .map((r) => r.SK)
        .sort()
        .reverse()
    );
  });

  it('caps a page at 100 and defaults to 25', async () => {
    partition(300);
    expect((await listHouseholdAudit(HH, { limit: 5000 })).items).toHaveLength(100);
    expect((await listHouseholdAudit(HH)).items).toHaveLength(25);
  });

  it('rebuilds the partition from the household, so a cursor cannot page another household', async () => {
    partition(3, 'hh-victim');
    const foreign = Buffer.from('AUDIT#2026-09-01T00:00:02.000Z#e0002').toString('base64url');
    const page = await listHouseholdAudit('hh-attacker', { cursor: foreign });
    const query = send.mock.calls[0][0] as unknown as Cmd;
    expect(query.input.ExclusiveStartKey).toEqual({
      PK: 'HOUSEHOLD#hh-attacker#AUDIT',
      SK: 'AUDIT#2026-09-01T00:00:02.000Z#e0002',
    });
    expect(page.items).toEqual([]);
  });

  it('refuses a cursor that is not an audit sort key', async () => {
    partition(3);
    const bogus = Buffer.from('PLANT#123').toString('base64url');
    await expect(listHouseholdAudit(HH, { cursor: bogus })).rejects.toMatchObject({
      name: 'AuditCursorError',
    });
  });

  it('leaves out rows past retention that the TTL sweep has not reached', async () => {
    send.mockResolvedValueOnce({
      Items: [
        { SK: 'AUDIT#b', ttl: 4_102_444_800 },
        { SK: 'AUDIT#a', ttl: 1 },
      ],
    } as never);
    const page = await listHouseholdAudit(HH);
    expect(page.items.map((i) => i.SK)).toEqual(['AUDIT#b']);
    expect(page.nextCursor).toBeNull();
  });
});
