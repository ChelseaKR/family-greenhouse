import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DeleteCommand: vi.fn(function (input) {
    return { kind: 'Delete', input };
  }),
  GetCommand: vi.fn(function (input) {
    return { kind: 'Get', input };
  }),
  PutCommand: vi.fn(function (input) {
    return { kind: 'Put', input };
  }),
  QueryCommand: vi.fn(function (input) {
    return { kind: 'Query', input };
  }),
  UpdateCommand: vi.fn(function (input) {
    return { kind: 'Update', input };
  }),
}));

vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));

describe('spaceService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists spaces alphabetically and hydrates legacy rain exposure', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { getSpaces } = await import('../../../src/services/spaceService.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Items: [
        { id: 'b', householdId: 'hh', name: 'Yard', environment: 'outside' },
        { id: 'a', householdId: 'hh', name: 'Kitchen', environment: 'inside' },
      ],
    });
    await expect(getSpaces('hh')).resolves.toMatchObject([
      {
        id: 'a',
        name: 'Kitchen',
        rainExposure: 'sheltered',
        lightLevel: null,
        petAccess: null,
      },
      {
        id: 'b',
        name: 'Yard',
        rainExposure: 'exposed',
        lightLevel: null,
        petAccess: null,
      },
    ]);
  });

  it('creates a trimmed household space after checking uniqueness', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { createSpace } = await import('../../../src/services/spaceService.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Items: [] }).mockResolvedValueOnce({});
    const result = await createSpace({ name: '  Living room  ', environment: 'inside' }, 'hh', 'u');
    expect(result).toMatchObject({
      householdId: 'hh',
      name: 'Living room',
      environment: 'inside',
      rainExposure: 'sheltered',
      createdBy: 'u',
    });
    expect(vi.mocked(dynamodb.send).mock.calls[1][0]).toMatchObject({
      kind: 'Put',
      input: { Item: { PK: 'HOUSEHOLD#hh', entityType: 'PlantSpace' } },
    });
  });

  it('keeps an outdoor space sheltered when explicitly covered', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { createSpace } = await import('../../../src/services/spaceService.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Items: [] }).mockResolvedValueOnce({});
    await expect(
      createSpace(
        { name: 'Covered porch', environment: 'outside', rainExposure: 'sheltered' },
        'hh',
        'u'
      )
    ).resolves.toMatchObject({ environment: 'outside', rainExposure: 'sheltered' });
  });

  it('persists optional light and pet-access details', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { createSpace } = await import('../../../src/services/spaceService.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Items: [] }).mockResolvedValueOnce({});

    await expect(
      createSpace(
        {
          name: 'Sunny pet room',
          environment: 'inside',
          lightLevel: 'bright',
          petAccess: true,
        },
        'hh',
        'u'
      )
    ).resolves.toMatchObject({ lightLevel: 'bright', petAccess: true });
  });

  it('updates and clears placement-fit properties', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { updateSpace } = await import('../../../src/services/spaceService.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Attributes: {
        id: 'space-1',
        householdId: 'hh',
        name: 'Room',
        environment: 'inside',
        lightLevel: null,
        petAccess: false,
      },
    });

    const result = await updateSpace('hh', 'space-1', {
      lightLevel: null,
      petAccess: false,
    });

    expect(result).toMatchObject({ lightLevel: null, petAccess: false });
    const update = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      input: { UpdateExpression: string; ExpressionAttributeValues: Record<string, unknown> };
    };
    expect(update.input.UpdateExpression).toContain('#lightLevel = :lightLevel');
    expect(update.input.UpdateExpression).toContain('#petAccess = :petAccess');
    expect(update.input.ExpressionAttributeValues).toMatchObject({
      ':lightLevel': null,
      ':petAccess': false,
    });
  });

  it('rejects a case-insensitive duplicate name', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { createSpace } = await import('../../../src/services/spaceService.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Items: [{ id: 'a', householdId: 'hh', name: 'Kitchen', environment: 'inside' }],
    });
    await expect(
      createSpace({ name: 'kitchen', environment: 'inside' }, 'hh', 'u')
    ).rejects.toMatchObject({ name: 'DuplicateSpaceNameError' });
  });
});
