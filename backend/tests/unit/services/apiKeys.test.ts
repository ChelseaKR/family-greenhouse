import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  PutCommand: vi.fn((i) => ({ input: i, kind: 'Put' })),
  QueryCommand: vi.fn((i) => ({ input: i, kind: 'Query' })),
  DeleteCommand: vi.fn((i) => ({ input: i, kind: 'Delete' })),
  UpdateCommand: vi.fn((i) => ({ input: i, kind: 'Update' })),
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

  it('createApiKey defaults to all read scopes when none requested', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({});
    const { createApiKey, API_SCOPES } = await import('../../../src/services/apiKeys.js');
    const result = await createApiKey('hh-1', 'user-1', 'unscoped');
    expect(result.record.scopes).toEqual([...API_SCOPES]);
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
    const { lookupApiKey, API_SCOPES } = await import('../../../src/services/apiKeys.js');
    const result = await lookupApiKey('fg_legacy');
    expect(result?.scopes).toEqual([...API_SCOPES]);
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
