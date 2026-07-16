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
      { id: 'a', name: 'Kitchen', rainExposure: 'sheltered' },
      { id: 'b', name: 'Yard', rainExposure: 'exposed' },
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
