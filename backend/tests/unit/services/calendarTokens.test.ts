import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  PutCommand: vi.fn(function (i) {
    return { input: i, kind: 'Put' };
  }),
  GetCommand: vi.fn(function (i) {
    return { input: i, kind: 'Get' };
  }),
  QueryCommand: vi.fn(function (i) {
    return { input: i, kind: 'Query' };
  }),
  DeleteCommand: vi.fn(function (i) {
    return { input: i, kind: 'Delete' };
  }),
  UpdateCommand: vi.fn(function (i) {
    return { input: i, kind: 'Update' };
  }),
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test',
}));

type Sent = { input: Record<string, unknown>; kind: string };

async function load() {
  const { dynamodb } = await import('../../../src/utils/dynamodb.js');
  const svc = await import('../../../src/services/calendarTokens.js');
  return { dynamodb, svc };
}

function sentCommand(dynamodb: { send: unknown }, n: number): Sent {
  return vi.mocked(dynamodb.send as (...a: unknown[]) => unknown).mock.calls[n][0] as Sent;
}

const USER = 'user-1';
const HH = 'hh-1';

describe('calendarTokens service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createCalendarToken', () => {
    it('mints a 256-bit hex token and stores only its hash, in the user partition', async () => {
      const { dynamodb, svc } = await load();
      vi.mocked(dynamodb.send).mockResolvedValueOnce({} as never);

      const result = await svc.createCalendarToken(USER, HH);

      expect(result.token).toMatch(/^[0-9a-f]{64}$/);
      expect(result.record).toEqual({
        userId: USER,
        householdId: HH,
        createdAt: expect.any(String),
        lastUsedAt: null,
      });

      const cmd = sentCommand(dynamodb, 0);
      expect(cmd.kind).toBe('Put');
      const item = cmd.input.Item as Record<string, unknown>;
      // Base row in the user's own partition: swept by deleteUserScopedData,
      // and a point read for status/regenerate/revoke.
      expect(item.PK).toBe(`USER#${USER}`);
      expect(item.SK).toBe(`CALTOKEN#${HH}`);
      expect(item.entityType).toBe('CalendarToken');
      // Lookup key is the scrypt hash on GSI1 — never the plaintext.
      expect(item.GSI1PK).toBe(`CALTOKEN_HASH#${svc._internal.hashToken(result.token)}`);
      expect(item.GSI1SK).toBe(`USER#${USER}`);
      expect(JSON.stringify(item)).not.toContain(result.token);
    });

    it('never mints the same token twice (entropy sanity)', async () => {
      const { dynamodb, svc } = await load();
      vi.mocked(dynamodb.send).mockResolvedValue({} as never);
      const a = await svc.createCalendarToken(USER, HH);
      const b = await svc.createCalendarToken(USER, HH);
      expect(a.token).not.toBe(b.token);
    });

    it('regenerate is an overwrite: the second mint targets the SAME row key', async () => {
      const { dynamodb, svc } = await load();
      vi.mocked(dynamodb.send).mockResolvedValue({} as never);
      await svc.createCalendarToken(USER, HH);
      await svc.createCalendarToken(USER, HH);
      const first = sentCommand(dynamodb, 0).input.Item as Record<string, unknown>;
      const second = sentCommand(dynamodb, 1).input.Item as Record<string, unknown>;
      expect([second.PK, second.SK]).toEqual([first.PK, first.SK]);
      // …with a different hash, so the old URL no longer resolves anywhere.
      expect(second.GSI1PK).not.toBe(first.GSI1PK);
    });
  });

  describe('hashToken', () => {
    it('is deterministic (lookup-by-hash needs it) and namespaced away from API keys', async () => {
      const { svc } = await load();
      const apiKeys = await import('../../../src/services/apiKeys.js');
      const token = 'ab'.repeat(32);
      expect(svc._internal.hashToken(token)).toBe(svc._internal.hashToken(token));
      expect(svc._internal.hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
      // Different fixed salt: pasting a calendar token where an API key is
      // expected (or vice versa) can never land on the other's index key.
      expect(svc._internal.hashToken(token)).not.toBe(apiKeys._internal.hashKey(token));
    });
  });

  describe('getCalendarToken', () => {
    it('returns the non-secret record for the (user, household) point read', async () => {
      const { dynamodb, svc } = await load();
      vi.mocked(dynamodb.send).mockResolvedValueOnce({
        Item: {
          PK: `USER#${USER}`,
          SK: `CALTOKEN#${HH}`,
          userId: USER,
          householdId: HH,
          createdAt: '2026-09-01T00:00:00.000Z',
          lastUsedAt: '2026-09-02T00:00:00.000Z',
        },
      } as never);
      const record = await svc.getCalendarToken(USER, HH);
      expect(record).toEqual({
        userId: USER,
        householdId: HH,
        createdAt: '2026-09-01T00:00:00.000Z',
        lastUsedAt: '2026-09-02T00:00:00.000Z',
      });
      const cmd = sentCommand(dynamodb, 0);
      expect(cmd.kind).toBe('Get');
      expect(cmd.input.Key).toEqual({ PK: `USER#${USER}`, SK: `CALTOKEN#${HH}` });
    });

    it('returns null when the user has no token for that household', async () => {
      const { dynamodb, svc } = await load();
      vi.mocked(dynamodb.send).mockResolvedValueOnce({} as never);
      expect(await svc.getCalendarToken(USER, HH)).toBeNull();
    });
  });

  describe('revokeCalendarToken', () => {
    it('deletes the row and returns true', async () => {
      const { dynamodb, svc } = await load();
      vi.mocked(dynamodb.send).mockResolvedValueOnce({} as never);
      expect(await svc.revokeCalendarToken(USER, HH)).toBe(true);
      const cmd = sentCommand(dynamodb, 0);
      expect(cmd.kind).toBe('Delete');
      expect(cmd.input.Key).toEqual({ PK: `USER#${USER}`, SK: `CALTOKEN#${HH}` });
      expect(cmd.input.ConditionExpression).toBe('attribute_exists(PK)');
    });

    it('returns false (→ 404) when there was nothing to revoke', async () => {
      const { dynamodb, svc } = await load();
      const err = new Error('nope');
      err.name = 'ConditionalCheckFailedException';
      vi.mocked(dynamodb.send).mockRejectedValueOnce(err);
      expect(await svc.revokeCalendarToken(USER, HH)).toBe(false);
    });

    it('rethrows unexpected DynamoDB errors', async () => {
      const { dynamodb, svc } = await load();
      vi.mocked(dynamodb.send).mockRejectedValueOnce(new Error('throttled'));
      await expect(svc.revokeCalendarToken(USER, HH)).rejects.toThrow('throttled');
    });
  });

  describe('resolveCalendarToken', () => {
    const row = {
      PK: `USER#${USER}`,
      SK: `CALTOKEN#${HH}`,
      GSI1PK: 'CALTOKEN_HASH#placeholder',
      userId: USER,
      householdId: HH,
      createdAt: '2026-09-01T00:00:00.000Z',
      lastUsedAt: null,
    };

    it('rejects a malformed token without touching DynamoDB', async () => {
      const { dynamodb, svc } = await load();
      expect(await svc.resolveCalendarToken('')).toBeNull();
      expect(await svc.resolveCalendarToken('fg_notacalendartoken')).toBeNull();
      expect(await svc.resolveCalendarToken('A'.repeat(64))).toBeNull(); // uppercase
      expect(await svc.resolveCalendarToken('a'.repeat(63))).toBeNull(); // short
      expect(await svc.resolveCalendarToken('a'.repeat(65))).toBeNull(); // long
      expect(dynamodb.send).not.toHaveBeenCalled();
    });

    it('returns null when no row carries the hash (unknown or revoked)', async () => {
      const { dynamodb, svc } = await load();
      vi.mocked(dynamodb.send).mockResolvedValueOnce({ Items: [] } as never);
      expect(await svc.resolveCalendarToken('a'.repeat(64))).toBeNull();
      const cmd = sentCommand(dynamodb, 0);
      expect(cmd.kind).toBe('Query');
      expect(cmd.input.IndexName).toBe('GSI1');
      expect(cmd.input.KeyConditionExpression).toBe('GSI1PK = :pk');
      expect((cmd.input.ExpressionAttributeValues as Record<string, string>)[':pk']).toBe(
        `CALTOKEN_HASH#${svc._internal.hashToken('a'.repeat(64))}`
      );
    });

    it('resolves a known hash and bumps lastUsedAt conditioned on the row STILL holding that hash', async () => {
      const { dynamodb, svc } = await load();
      const token = 'b'.repeat(64);
      const hash = `CALTOKEN_HASH#${svc._internal.hashToken(token)}`;
      vi.mocked(dynamodb.send)
        .mockResolvedValueOnce({ Items: [{ ...row, GSI1PK: hash }] } as never)
        .mockResolvedValueOnce({} as never);

      const grant = await svc.resolveCalendarToken(token);
      expect(grant).toEqual({
        userId: USER,
        householdId: HH,
        createdAt: row.createdAt,
        lastUsedAt: null,
      });

      const update = sentCommand(dynamodb, 1);
      expect(update.kind).toBe('Update');
      expect(update.input.Key).toEqual({ PK: row.PK, SK: row.SK });
      expect(update.input.UpdateExpression).toBe('SET lastUsedAt = :now');
      // The freshness check: a stale GSI read after regenerate/revoke must
      // fail this condition rather than be honoured.
      expect(update.input.ConditionExpression).toBe('attribute_exists(PK) AND #hash = :hash');
      expect(update.input.ExpressionAttributeNames).toEqual({ '#hash': 'GSI1PK' });
      expect((update.input.ExpressionAttributeValues as Record<string, string>)[':hash']).toBe(
        hash
      );
    });

    it('refuses a token whose row was regenerated/revoked between the index read and the write', async () => {
      const { dynamodb, svc } = await load();
      const err = new Error('stale');
      err.name = 'ConditionalCheckFailedException';
      vi.mocked(dynamodb.send)
        .mockResolvedValueOnce({ Items: [row] } as never)
        .mockRejectedValueOnce(err);
      expect(await svc.resolveCalendarToken('c'.repeat(64))).toBeNull();
    });

    it('still honours the token when only the lastUsedAt telemetry write fails', async () => {
      const { dynamodb, svc } = await load();
      vi.mocked(dynamodb.send)
        .mockResolvedValueOnce({ Items: [row] } as never)
        .mockRejectedValueOnce(new Error('throttled'));
      const grant = await svc.resolveCalendarToken('d'.repeat(64));
      expect(grant?.householdId).toBe(HH);
    });
  });

  describe('calendarFeedPath', () => {
    it('places the token as a whole path segment (API Gateway needs {token} to own a segment)', async () => {
      const { svc } = await load();
      expect(svc.calendarFeedPath('e'.repeat(64))).toBe(
        `/calendar/${'e'.repeat(64)}/family-greenhouse.ics`
      );
    });
  });
});
