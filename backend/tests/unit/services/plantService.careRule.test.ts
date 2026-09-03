import { describe, it, expect, vi, beforeEach } from 'vitest';

const { s3Send } = vi.hoisted(() => ({ s3Send: vi.fn() }));

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
  UpdateCommand: vi.fn(function (input) {
    return { input, kind: 'Update' };
  }),
  BatchWriteCommand: vi.fn(function (input) {
    return { input, kind: 'BatchWrite' };
  }),
  TransactWriteCommand: vi.fn(function (input) {
    return { input, kind: 'TransactWrite' };
  }),
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(function () {
    return { send: s3Send };
  }),
  ListObjectVersionsCommand: vi.fn(function (input) {
    return { input, kind: 'ListObjectVersions' };
  }),
  DeleteObjectsCommand: vi.fn(function (input) {
    return { input, kind: 'DeleteObjects' };
  }),
}));

vi.mock('../../../src/utils/dynamodb', () => ({
  dynamodb: {
    send: vi.fn(),
  },
  TABLE_NAME: 'test-table',
}));

type CreateTransact = {
  input: { TransactItems: [unknown, { Put: { Item: Record<string, unknown> } }] };
};
type UpdateCall = {
  input: {
    UpdateExpression: string;
    ExpressionAttributeNames: Record<string, string>;
    ExpressionAttributeValues: Record<string, unknown>;
  };
};

const legacyRow = {
  id: 'p1',
  householdId: 'hh',
  name: 'Calathea',
  species: null,
  location: null,
  imageUrl: null,
  notes: null,
  createdAt: '',
  createdBy: 'u',
  updatedAt: '',
};

/**
 * `careRule` persistence: written as its own attribute, hydrated to null
 * (never undefined) on rows that predate it, and cleared — not stored as ""
 * — when a member empties the field. A blank must never reach the
 * completion-time surface as a rule.
 */
describe('plantService careRule (house rule) persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('createPlant stores the rule on the plant row and returns it', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb');
    const { createPlant } = await import('../../../src/services/plantService');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: { plantCount: 0 } });
    vi.mocked(dynamodb.send).mockResolvedValueOnce({});

    const result = await createPlant(
      { name: 'Calathea', careRule: 'bottom-water only' },
      'hh',
      'u',
      10
    );

    expect(result.careRule).toBe('bottom-water only');
    const transact = vi.mocked(dynamodb.send).mock.calls[1][0] as unknown as CreateTransact;
    expect(transact.input.TransactItems[1].Put.Item).toMatchObject({
      careRule: 'bottom-water only',
    });
  });

  it('createPlant stores null — not "" — when no rule is given', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb');
    const { createPlant } = await import('../../../src/services/plantService');

    for (const input of [{ name: 'Calathea' }, { name: 'Calathea', careRule: '' }]) {
      vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: { plantCount: 0 } });
      vi.mocked(dynamodb.send).mockResolvedValueOnce({});
      const result = await createPlant(input, 'hh', 'u', 10);
      expect(result.careRule).toBeNull();
      const calls = vi.mocked(dynamodb.send).mock.calls;
      const transact = calls[calls.length - 1][0] as unknown as CreateTransact;
      expect(transact.input.TransactItems[1].Put.Item).toHaveProperty('careRule', null);
    }
  });

  it('getPlant hydrates rows that predate the field to null, never undefined', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb');
    const { getPlant } = await import('../../../src/services/plantService');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: legacyRow });

    const result = await getPlant('hh', 'p1');

    expect(result).toHaveProperty('careRule', null);
  });

  it('getPlant and getPlants return the stored rule', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb');
    const { getPlant, getPlants } = await import('../../../src/services/plantService');
    const row = { ...legacyRow, careRule: 'bottom-water only' };

    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: row });
    expect((await getPlant('hh', 'p1'))?.careRule).toBe('bottom-water only');

    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Items: [row, { ...legacyRow, id: 'p2' }] });
    const list = await getPlants('hh');
    expect(list.map((p) => [p.id, p.careRule])).toEqual([
      ['p1', 'bottom-water only'],
      ['p2', null],
    ]);
  });

  it('updatePlant writes the rule as its own attribute and returns it', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb');
    const { updatePlant } = await import('../../../src/services/plantService');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Attributes: { ...legacyRow, status: 'active', careRule: 'bottom-water only' },
    });

    const result = await updatePlant('hh', 'p1', { careRule: 'bottom-water only' }, 10);

    expect(result?.careRule).toBe('bottom-water only');
    const update = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as UpdateCall;
    expect(update.input.UpdateExpression).toContain('#careRule = :careRule');
    expect(update.input.ExpressionAttributeNames).toMatchObject({ '#careRule': 'careRule' });
    expect(update.input.ExpressionAttributeValues).toMatchObject({
      ':careRule': 'bottom-water only',
    });
  });

  it('updatePlant clears the rule to null for null AND for an emptied field', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb');
    const { updatePlant } = await import('../../../src/services/plantService');

    for (const careRule of [null, '']) {
      vi.mocked(dynamodb.send).mockResolvedValueOnce({
        Attributes: { ...legacyRow, status: 'active', careRule: null },
      });
      const result = await updatePlant('hh', 'p1', { careRule }, 10);
      expect(result?.careRule).toBeNull();
      const calls = vi.mocked(dynamodb.send).mock.calls;
      const update = calls[calls.length - 1][0] as unknown as UpdateCall;
      expect(update.input.ExpressionAttributeValues[':careRule']).toBeNull();
    }
  });

  it('updatePlant leaves the rule untouched when the key is omitted', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb');
    const { updatePlant } = await import('../../../src/services/plantService');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Attributes: { ...legacyRow, status: 'active', careRule: 'bottom-water only' },
    });

    const result = await updatePlant('hh', 'p1', { name: 'Renamed' }, 10);

    const update = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as UpdateCall;
    expect(update.input.UpdateExpression).not.toContain('careRule');
    // The row's existing rule still comes back on the response.
    expect(result?.careRule).toBe('bottom-water only');
  });
});
