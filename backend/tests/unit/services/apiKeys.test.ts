import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  PutCommand: vi.fn(function (i) {
    return { input: i, kind: 'Put' };
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

describe('apiKeys service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('createApiKey writes a hashed row + returns plaintext exactly once', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({});
    const { createApiKey, _internal } = await import('../../../src/services/apiKeys.js');
    const result = await createApiKey('hh-1', 'user-1', 'My script');
    expect(result.plaintext).toMatch(/^fg_[0-9a-f]{48}$/);
    expect(result.record.label).toBe('My script');
    expect(result.record.last4).toBe(result.plaintext.slice(-4));
    const cmd = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      input: { Item: Record<string, unknown> };
    };
    // The stored row carries the hash on GSI3PK, never the plaintext.
    expect(cmd.input.Item.GSI3PK).toBe(`APIKEY_HASH#${_internal.hashKey(result.plaintext)}`);
    expect(JSON.stringify(cmd.input.Item)).not.toContain(result.plaintext.slice(3));
  });

  it('createApiKey stores the requested scopes', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({});
    const { createApiKey } = await import('../../../src/services/apiKeys.js');
    const result = await createApiKey('hh-1', 'user-1', 'scoped', ['read:plants']);
    expect(result.record.scopes).toEqual(['read:plants']);
    const cmd = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      input: { Item: Record<string, unknown> };
    };
    expect(cmd.input.Item.scopes).toEqual(['read:plants']);
  });

  it('createApiKey defaults to all READ scopes (never write) when none requested', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({});
    const { createApiKey, READ_API_SCOPES } = await import('../../../src/services/apiKeys.js');
    const result = await createApiKey('hh-1', 'user-1', 'unscoped');
    expect(result.record.scopes).toEqual([...READ_API_SCOPES]);
    expect(result.record.scopes).not.toContain('write:tasks');
  });

  it('createApiKey stores write:tasks when explicitly requested', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({});
    const { createApiKey } = await import('../../../src/services/apiKeys.js');
    const result = await createApiKey('hh-1', 'user-1', 'automation', [
      'read:tasks',
      'write:tasks',
    ]);
    expect(result.record.scopes).toEqual(['read:tasks', 'write:tasks']);
  });

  it('lookupApiKey treats a legacy row with no scopes as all read scopes', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({
        Items: [
          {
            PK: 'HOUSEHOLD#hh',
            SK: 'APIKEY#k1',
            id: 'k1',
            householdId: 'hh',
            label: 'legacy',
            last4: 'abcd',
            createdAt: '2026',
            createdBy: 'u',
            lastUsedAt: null,
            // no `scopes` attribute — minted before scopes existed
          },
        ],
      })
      .mockResolvedValueOnce({});
    const { lookupApiKey, READ_API_SCOPES } = await import('../../../src/services/apiKeys.js');
    const result = await lookupApiKey('fg_legacy');
    // Legacy expansion is read-only: keys minted under the read-only API
    // contract must NEVER silently gain write scopes.
    expect(result?.scopes).toEqual([...READ_API_SCOPES]);
    expect(result?.scopes).not.toContain('write:tasks');
  });

  it('lookupApiKey returns null for keys without the fg_ prefix', async () => {
    const { lookupApiKey } = await import('../../../src/services/apiKeys.js');
    expect(await lookupApiKey('not-fg-prefix')).toBeNull();
  });

  it('lookupApiKey returns null when GSI3 returns no match', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Items: [] });
    const { lookupApiKey } = await import('../../../src/services/apiKeys.js');
    expect(await lookupApiKey('fg_aaaa')).toBeNull();
  });

  it('lookupApiKey returns the record for a known hash', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    // 1st send: the GSI3 query. 2nd send: the best-effort lastUsedAt
    // update — its promise is `.catch()`-chained, so it must resolve.
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({
        Items: [
          {
            PK: 'HOUSEHOLD#hh',
            SK: 'APIKEY#k1',
            id: 'k1',
            householdId: 'hh',
            label: 'thing',
            last4: 'abcd',
            createdAt: '2026',
            createdBy: 'u',
            lastUsedAt: null,
          },
        ],
      })
      .mockResolvedValueOnce({});
    const { lookupApiKey } = await import('../../../src/services/apiKeys.js');
    const result = await lookupApiKey('fg_anything');
    expect(result?.id).toBe('k1');
    expect(result?.householdId).toBe('hh');
  });

  it('lookupApiKey awaits a CONDITIONED lastUsedAt bump (no revoked-key resurrection)', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({
        Items: [
          {
            PK: 'HOUSEHOLD#hh',
            SK: 'APIKEY#k1',
            id: 'k1',
            householdId: 'hh',
            label: 'thing',
            last4: 'abcd',
            createdAt: '2026',
            createdBy: 'u',
            lastUsedAt: null,
          },
        ],
      })
      .mockResolvedValueOnce({});
    const { lookupApiKey } = await import('../../../src/services/apiKeys.js');
    await lookupApiKey('fg_anything');
    // The bump runs before lookupApiKey resolves (awaited, not fire-and-forget).
    expect(vi.mocked(dynamodb.send)).toHaveBeenCalledTimes(2);
    const update = vi.mocked(dynamodb.send).mock.calls[1][0] as unknown as {
      kind: string;
      input: { ConditionExpression: string };
    };
    expect(update.kind).toBe('Update');
    // attribute_exists: an unconditioned Update would re-create a bare row
    // for a key revoked between the GSI read and the bump.
    expect(update.input.ConditionExpression).toBe('attribute_exists(PK)');
  });

  it('lookupApiKey returns null when the key was revoked concurrently (bump condition fails)', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({
        Items: [
          {
            PK: 'HOUSEHOLD#hh',
            SK: 'APIKEY#k1',
            id: 'k1',
            householdId: 'hh',
            label: 'thing',
            last4: 'abcd',
            createdAt: '2026',
            createdBy: 'u',
            lastUsedAt: null,
          },
        ],
      })
      .mockRejectedValueOnce(
        Object.assign(new Error('gone'), { name: 'ConditionalCheckFailedException' })
      );
    const { lookupApiKey } = await import('../../../src/services/apiKeys.js');
    expect(await lookupApiKey('fg_anything')).toBeNull();
  });

  it('revokeApiKey returns true on delete, false when the key never existed', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { revokeApiKey } = await import('../../../src/services/apiKeys.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({});
    expect(await revokeApiKey('hh', 'k1')).toBe(true);
    vi.mocked(dynamodb.send).mockRejectedValueOnce(
      Object.assign(new Error('missing'), { name: 'ConditionalCheckFailedException' })
    );
    expect(await revokeApiKey('hh', 'nope')).toBe(false);
  });

  it('listApiKeys queries the household partition for APIKEY rows', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Items: [] });
    const { listApiKeys } = await import('../../../src/services/apiKeys.js');
    await listApiKeys('hh-1');
    const cmd = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      input: { ExpressionAttributeValues: Record<string, string> };
    };
    expect(cmd.input.ExpressionAttributeValues[':pk']).toBe('HOUSEHOLD#hh-1');
    expect(cmd.input.ExpressionAttributeValues[':sk']).toBe('APIKEY#');
  });
});
