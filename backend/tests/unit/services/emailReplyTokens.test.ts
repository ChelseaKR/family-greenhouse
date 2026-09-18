import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  PutCommand: vi.fn(function (input) {
    return { input, kind: 'Put' };
  }),
  GetCommand: vi.fn(function (input) {
    return { input, kind: 'Get' };
  }),
  UpdateCommand: vi.fn(function (input) {
    return { input, kind: 'Update' };
  }),
  DeleteCommand: vi.fn(function (input) {
    return { input, kind: 'Delete' };
  }),
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));

import { dynamodb } from '../../../src/utils/dynamodb.js';
import {
  MAX_REPLIES_PER_TOKEN,
  REPLY_TOKEN_TTL_SECONDS,
  claimReplySend,
  digestOf,
  mintReplyToken,
  readReplyToken,
} from '../../../src/services/emailReplyTokens.js';
import { hashCapabilityToken } from '../../../src/utils/tokenHash.js';

const NOW = new Date('2026-09-17T15:00:00.000Z');
const send = vi.mocked(dynamodb.send);

type Captured = { kind: string; input: Record<string, unknown> };
const lastCommand = () => send.mock.calls[send.mock.calls.length - 1][0] as unknown as Captured;

beforeEach(() => {
  vi.clearAllMocks();
  send.mockResolvedValue({} as never);
});

describe('mintReplyToken', () => {
  it('stores the row under the scrypt digest and nothing that reproduces the token', async () => {
    const minted = await mintReplyToken(
      {
        userId: 'u1',
        householdId: 'hh',
        locale: 'en',
        timeZone: 'America/Chicago',
        tasks: [{ taskId: 't1', expectedNextDue: '2026-09-17T09:00:00.000Z' }],
      },
      NOW
    );
    expect(minted.status).toBe('ok');
    const token = (minted as { token: string }).token;
    const { input } = lastCommand();
    const item = input.Item as Record<string, unknown>;

    expect(item.PK).toBe(`EMAILREPLY#${hashCapabilityToken('emailReply', token)}`);
    expect(digestOf(token)).toMatch(/^[0-9a-f]{64}$/);
    // The plaintext appears nowhere on the row.
    expect(JSON.stringify(item)).not.toContain(token);
    expect(input.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(item.expiresAt).toBe(Math.floor(NOW.getTime() / 1000) + REPLY_TOKEN_TTL_SECONDS);
    expect(Number(item.ttl)).toBeGreaterThan(Number(item.expiresAt));
    expect(item.repliesSent).toBe(0);
    expect(item.tasks).toEqual([{ taskId: 't1', expectedNextDue: '2026-09-17T09:00:00.000Z' }]);
  });

  it('refuses an empty task list and reports a failed write as unavailable, not as a token', async () => {
    const base = { userId: 'u1', householdId: 'hh', locale: 'en' as const, timeZone: 'UTC' };
    expect(await mintReplyToken({ ...base, tasks: [] }, NOW)).toEqual({
      status: 'unavailable',
      reason: 'task_count',
    });
    send.mockRejectedValueOnce(new Error('boom'));
    expect(
      await mintReplyToken({ ...base, tasks: [{ taskId: 't', expectedNextDue: 'x' }] }, NOW)
    ).toEqual({ status: 'unavailable', reason: 'write_failed' });
  });
});

describe('readReplyToken', () => {
  it('looks the token up by its digest', async () => {
    send.mockResolvedValueOnce({} as never);
    expect(await readReplyToken('a'.repeat(40))).toEqual({ status: 'missing' });
    expect((lastCommand().input.Key as { PK: string }).PK).toBe(
      `EMAILREPLY#${digestOf('a'.repeat(40))}`
    );
  });

  it('treats a row it cannot trust as malformed', async () => {
    send.mockResolvedValueOnce({
      Item: {
        userId: 'u1',
        householdId: 'hh',
        locale: 'fr',
        timeZone: 'UTC',
        expiresAt: 1,
        tasks: [],
      },
    } as never);
    expect(await readReplyToken('a'.repeat(40))).toEqual({ status: 'malformed' });
  });

  it('lets a read failure throw rather than answer', async () => {
    send.mockRejectedValueOnce(new Error('throttled'));
    await expect(readReplyToken('a'.repeat(40))).rejects.toThrow('throttled');
  });
});

describe('claimReplySend', () => {
  it('charges the budget and makes help once-only, atomically', async () => {
    expect(await claimReplySend('d', 'help', NOW)).toBe('claimed');
    const { input } = lastCommand();
    expect(input.ConditionExpression).toBe(
      'attribute_exists(PK) AND repliesSent < :max AND attribute_not_exists(#once)'
    );
    expect(input.ExpressionAttributeNames).toEqual({ '#once': 'helpSentAt' });
    expect((input.ExpressionAttributeValues as Record<string, unknown>)[':max']).toBe(
      MAX_REPLIES_PER_TOKEN
    );
  });

  it('answers exhausted on a failed condition and rethrows anything else', async () => {
    const ccf = Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' });
    send.mockRejectedValueOnce(ccf);
    expect(await claimReplySend('d', 'outcome', NOW)).toBe('exhausted');
    send.mockRejectedValueOnce(new Error('throttled'));
    await expect(claimReplySend('d', 'outcome', NOW)).rejects.toThrow('throttled');
  });
});
