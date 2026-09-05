import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  GetCommand: vi.fn(function (i) {
    return { input: i, kind: 'Get' };
  }),
  PutCommand: vi.fn(function (i) {
    return { input: i, kind: 'Put' };
  }),
  UpdateCommand: vi.fn(function (i) {
    return { input: i, kind: 'Update' };
  }),
  DeleteCommand: vi.fn(function (i) {
    return { input: i, kind: 'Delete' };
  }),
  BatchGetCommand: vi.fn(function (i) {
    return { input: i, kind: 'BatchGet' };
  }),
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));

import { dynamodb } from '../../../src/utils/dynamodb.js';
import * as emailSuppression from '../../../src/services/emailSuppression.js';

const send = dynamodb.send as unknown as ReturnType<typeof vi.fn>;
const NOW = new Date('2026-09-03T12:00:00.000Z');

function conditionalFailure(): Error {
  const err = new Error('conditional');
  err.name = 'ConditionalCheckFailedException';
  return err;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('emailSuppression.normalizeAddress', () => {
  it('lowercases and trims so SES event casing matches the stored row', () => {
    expect(emailSuppression.normalizeAddress('  Sam@Example.COM ')).toBe('sam@example.com');
  });
});

describe('emailSuppression.checkAddress', () => {
  it('reports sendable when there is no row', async () => {
    send.mockResolvedValueOnce({});
    await expect(emailSuppression.checkAddress('a@b.com')).resolves.toEqual({
      status: 'sendable',
    });
  });

  it('reports sendable for a transient row — soft bounces do not block sending', async () => {
    send.mockResolvedValueOnce({
      Item: {
        email: 'a@b.com',
        state: 'transient',
        softBounceCount: 2,
        firstEventAt: NOW.toISOString(),
        lastEventAt: NOW.toISOString(),
      },
    });
    await expect(emailSuppression.checkAddress('a@b.com')).resolves.toEqual({
      status: 'sendable',
    });
  });

  it('reports suppressed with the reason for a suppressed row', async () => {
    send.mockResolvedValueOnce({
      Item: {
        email: 'a@b.com',
        state: 'suppressed',
        reason: 'hard_bounce',
        detail: 'Permanent/General',
        softBounceCount: 0,
        firstEventAt: NOW.toISOString(),
        lastEventAt: NOW.toISOString(),
        suppressedAt: NOW.toISOString(),
      },
    });
    const result = await emailSuppression.checkAddress('a@b.com');
    expect(result.status).toBe('suppressed');
    expect(result.status === 'suppressed' && result.state.reason).toBe('hard_bounce');
  });

  it('reports unknown — never sendable — when the lookup itself fails', async () => {
    send.mockRejectedValueOnce(new Error('DynamoDB unavailable'));
    await expect(emailSuppression.checkAddress('a@b.com')).resolves.toEqual({
      status: 'unknown',
      reason: 'lookup_failed',
    });
  });

  it('reads the row from the address partition, keyed on the normalized address', async () => {
    send.mockResolvedValueOnce({});
    await emailSuppression.checkAddress('A@B.com');
    expect(send.mock.calls[0][0].input.Key).toEqual({
      PK: 'EMAIL#a@b.com',
      SK: 'DELIVERY_STATE',
    });
  });
});

describe('emailSuppression.getDeliveryStates', () => {
  it('returns an empty map without touching DynamoDB for an empty roster', async () => {
    await expect(emailSuppression.getDeliveryStates([])).resolves.toEqual({
      status: 'ok',
      states: new Map(),
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('maps normalized addresses to their stored state', async () => {
    send.mockResolvedValueOnce({
      Responses: {
        'test-table': [
          {
            email: 'gone@b.com',
            state: 'suppressed',
            reason: 'complaint',
            softBounceCount: 0,
            firstEventAt: NOW.toISOString(),
            lastEventAt: NOW.toISOString(),
          },
        ],
      },
    });
    const result = await emailSuppression.getDeliveryStates(['Gone@B.com', 'fine@b.com']);
    expect(result.status).toBe('ok');
    expect(result.status === 'ok' && result.states.get('gone@b.com')?.reason).toBe('complaint');
    expect(result.status === 'ok' && result.states.has('fine@b.com')).toBe(false);
  });

  it('reports unknown rather than a partial map when keys go unprocessed', async () => {
    send.mockResolvedValueOnce({
      Responses: { 'test-table': [] },
      UnprocessedKeys: { 'test-table': { Keys: [{ PK: 'EMAIL#a@b.com' }] } },
    });
    await expect(emailSuppression.getDeliveryStates(['a@b.com'])).resolves.toEqual({
      status: 'unknown',
    });
  });

  it('reports unknown when the batch read throws', async () => {
    send.mockRejectedValueOnce(new Error('boom'));
    await expect(emailSuppression.getDeliveryStates(['a@b.com'])).resolves.toEqual({
      status: 'unknown',
    });
  });

  // A roster over 100 is the case ADR 0014 made reachable: membership is
  // UNLIMITED on Garden and Greenhouse, and householdService.MEMBER_QUERY_LIMIT
  // is that query's page size, not a cap. These four cases fail on the code
  // this replaced, which refused any roster over 100 keys outright.
  const roster = (n: number) => Array.from({ length: n }, (_, i) => `m${i}@b.com`);

  it('chunks a roster over 100 into whole BatchGet requests covering every key', async () => {
    // `…Once` twice, never a standing `mockResolvedValue`: the shared
    // `beforeEach` calls `clearAllMocks`, which clears calls but NOT
    // implementations, so a standing one would answer every later test in the
    // file too.
    send
      .mockResolvedValueOnce({ Responses: { 'test-table': [] } })
      .mockResolvedValueOnce({ Responses: { 'test-table': [] } });

    const result = await emailSuppression.getDeliveryStates(roster(150));

    expect(result.status).toBe('ok');
    expect(send).toHaveBeenCalledTimes(2);
    const chunks = send.mock.calls.map(
      (c) => (c[0] as { input: { RequestItems: Record<string, { Keys: { PK: string }[] }> } }).input
    );
    expect(chunks[0].RequestItems['test-table'].Keys).toHaveLength(100);
    expect(chunks[1].RequestItems['test-table'].Keys).toHaveLength(50);
    // Every address is asked about exactly once — no key dropped between the
    // slices, none sent twice.
    const asked = chunks.flatMap((c) => c.RequestItems['test-table'].Keys.map((k) => k.PK));
    expect(new Set(asked).size).toBe(150);
    expect(asked).toEqual(roster(150).map((e) => `EMAIL#${e}`));
  });

  it('merges the chunks into one map, so a bounce past key 100 is still visible', async () => {
    const suppressed = (email: string) => ({
      email,
      state: 'suppressed',
      reason: 'bounce',
      softBounceCount: 0,
      firstEventAt: NOW.toISOString(),
      lastEventAt: NOW.toISOString(),
    });
    // One hit in the first chunk, one in the second: a merge that kept only the
    // last response, or only the first, drops one of these.
    send
      .mockResolvedValueOnce({ Responses: { 'test-table': [suppressed('m7@b.com')] } })
      .mockResolvedValueOnce({ Responses: { 'test-table': [suppressed('m130@b.com')] } });

    const result = await emailSuppression.getDeliveryStates(roster(150));

    expect(result.status).toBe('ok');
    expect(result.status === 'ok' && result.states.get('m7@b.com')?.state).toBe('suppressed');
    expect(result.status === 'ok' && result.states.get('m130@b.com')?.state).toBe('suppressed');
    expect(result.status === 'ok' && result.states.size).toBe(2);
    expect(result.status === 'ok' && result.states.has('m42@b.com')).toBe(false);
  });

  it('a later chunk leaving keys unprocessed makes the WHOLE roster unknown', async () => {
    send.mockResolvedValueOnce({ Responses: { 'test-table': [] } }).mockResolvedValueOnce({
      Responses: { 'test-table': [] },
      UnprocessedKeys: { 'test-table': { Keys: [{ PK: 'EMAIL#m130@b.com' }] } },
    });

    await expect(emailSuppression.getDeliveryStates(roster(150))).resolves.toEqual({
      status: 'unknown',
    });
  });

  it('a later chunk throwing makes the WHOLE roster unknown, not a partial map', async () => {
    send
      .mockResolvedValueOnce({ Responses: { 'test-table': [] } })
      .mockRejectedValueOnce(new Error('boom'));

    await expect(emailSuppression.getDeliveryStates(roster(150))).resolves.toEqual({
      status: 'unknown',
    });
  });

  it('sends exactly one request for a roster of exactly 100 — the boundary', async () => {
    send.mockResolvedValueOnce({ Responses: { 'test-table': [] } });
    const result = await emailSuppression.getDeliveryStates(roster(100));
    expect(result.status).toBe('ok');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends two requests for 101 — one key past the boundary is not a refusal', async () => {
    send
      .mockResolvedValueOnce({ Responses: { 'test-table': [] } })
      .mockResolvedValueOnce({ Responses: { 'test-table': [] } });
    const result = await emailSuppression.getDeliveryStates(roster(101));
    expect(result.status).toBe('ok');
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('emailSuppression bounce and complaint recording', () => {
  it('a permanent bounce writes a suppressed row with no TTL', async () => {
    send.mockResolvedValueOnce({});
    const state = await emailSuppression.recordHardBounce('A@b.com', 'Permanent/General', NOW);
    expect(state).toMatchObject({ state: 'suppressed', reason: 'hard_bounce' });
    const item = send.mock.calls[0][0].input.Item;
    expect(item.PK).toBe('EMAIL#a@b.com');
    expect(item.state).toBe('suppressed');
    // A dead mailbox does not come back to life because a week went by.
    expect(item.ttl).toBeUndefined();
  });

  it('a complaint suppresses immediately and permanently', async () => {
    send.mockResolvedValueOnce({});
    const state = await emailSuppression.recordComplaint('a@b.com', 'abuse', NOW);
    expect(state.reason).toBe('complaint');
    expect(send.mock.calls[0][0].input.Item.ttl).toBeUndefined();
  });

  it('a soft bounce increments a counter with a TTL and keeps the address sendable', async () => {
    send.mockResolvedValueOnce({
      Attributes: {
        email: 'a@b.com',
        state: 'transient',
        softBounceCount: 2,
        firstEventAt: NOW.toISOString(),
        lastEventAt: NOW.toISOString(),
      },
    });
    const state = await emailSuppression.recordSoftBounce('a@b.com', 'Transient/MailboxFull', NOW);
    expect(state.state).toBe('transient');
    expect(state.softBounceCount).toBe(2);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].input.ExpressionAttributeValues[':ttl']).toBeGreaterThan(
      Math.floor(NOW.getTime() / 1000)
    );
  });

  it('promotes to a suppression once soft bounces cross the limit', async () => {
    send.mockResolvedValueOnce({
      Attributes: {
        email: 'a@b.com',
        state: 'transient',
        softBounceCount: emailSuppression.SOFT_BOUNCE_LIMIT,
        firstEventAt: NOW.toISOString(),
        lastEventAt: NOW.toISOString(),
      },
    });
    send.mockResolvedValueOnce({});
    const state = await emailSuppression.recordSoftBounce('a@b.com', 'Transient/General', NOW);
    expect(state).toMatchObject({ state: 'suppressed', reason: 'soft_bounce_limit' });
    expect(send.mock.calls[1][0].kind).toBe('Put');
  });

  it('never walks an already-suppressed address back to transient', async () => {
    send.mockRejectedValueOnce(conditionalFailure());
    send.mockResolvedValueOnce({
      Item: {
        email: 'a@b.com',
        state: 'suppressed',
        reason: 'hard_bounce',
        softBounceCount: 0,
        firstEventAt: NOW.toISOString(),
        lastEventAt: NOW.toISOString(),
      },
    });
    const state = await emailSuppression.recordSoftBounce('a@b.com', 'Transient/General', NOW);
    expect(state).toMatchObject({ state: 'suppressed', reason: 'hard_bounce' });
  });

  it('rethrows a non-conditional soft-bounce failure instead of inventing a state', async () => {
    send.mockRejectedValueOnce(new Error('throttled'));
    await expect(emailSuppression.recordSoftBounce('a@b.com', 'x', NOW)).rejects.toThrow(
      'throttled'
    );
  });
});

describe('emailSuppression.recordDelivery', () => {
  it('clears a transient counter, conditionally on it still being transient', async () => {
    send.mockResolvedValueOnce({});
    await emailSuppression.recordDelivery('a@b.com');
    const input = send.mock.calls[0][0].input;
    expect(input.Key.PK).toBe('EMAIL#a@b.com');
    expect(input.ConditionExpression).toContain('#state');
    expect(input.ExpressionAttributeValues[':transient']).toBe('transient');
  });

  it('leaves a suppressed row alone — a delivery elsewhere does not un-suppress', async () => {
    send.mockRejectedValueOnce(conditionalFailure());
    await expect(emailSuppression.recordDelivery('a@b.com')).resolves.toBeUndefined();
  });

  it('rethrows an unexpected delete failure', async () => {
    send.mockRejectedValueOnce(new Error('nope'));
    await expect(emailSuppression.recordDelivery('a@b.com')).rejects.toThrow('nope');
  });
});

describe('emailSuppression.clearSuppression', () => {
  it('deletes the row unconditionally', async () => {
    send.mockResolvedValueOnce({});
    await emailSuppression.clearSuppression('A@b.com', 'user-1');
    const input = send.mock.calls[0][0].input;
    expect(input.Key).toEqual({ PK: 'EMAIL#a@b.com', SK: 'DELIVERY_STATE' });
    expect(input.ConditionExpression).toBeUndefined();
  });
});
