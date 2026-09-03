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

vi.mock('../../../src/services/householdService.js', () => ({
  getMemberByUserId: vi.fn(),
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

  it('persists a validated default caregiver', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const householdService = await import('../../../src/services/householdService.js');
    const { createSpace } = await import('../../../src/services/spaceService.js');
    vi.mocked(householdService.getMemberByUserId).mockResolvedValueOnce({
      householdId: 'hh',
      userId: 'user-2',
      name: 'Alex',
      email: 'alex@example.com',
      role: 'member',
      joinedAt: '',
    });
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Items: [] }).mockResolvedValueOnce({});

    await expect(
      createSpace(
        { name: 'Patio', environment: 'outside', defaultCaregiverId: 'user-2' },
        'hh',
        'u'
      )
    ).resolves.toMatchObject({ defaultCaregiverId: 'user-2' });
  });

  it('rejects a default caregiver outside the household', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const householdService = await import('../../../src/services/householdService.js');
    const { createSpace } = await import('../../../src/services/spaceService.js');
    vi.mocked(householdService.getMemberByUserId).mockResolvedValueOnce(null);

    await expect(
      createSpace(
        { name: 'Patio', environment: 'outside', defaultCaregiverId: 'outsider' },
        'hh',
        'u'
      )
    ).rejects.toMatchObject({ name: 'DefaultCaregiverNotMemberError' });
    expect(vi.mocked(dynamodb.send)).not.toHaveBeenCalled();
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

describe('spaceService — care rotation (ADR 0018)', () => {
  const rotation = { memberIds: ['sam', 'priya'], cadence: 'weekly' as const };

  it('rejects a rotation containing someone who is not a household member', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const household = await import('../../../src/services/householdService.js');
    const { createSpace } = await import('../../../src/services/spaceService.js');
    vi.mocked(household.getMemberByUserId).mockImplementation(async (_hh, userId) =>
      userId === 'sam' ? ({ userId: 'sam', name: 'Sam' } as never) : null
    );
    await expect(
      createSpace({ name: 'Balcony', environment: 'outside', rotation } as never, 'hh', 'sam')
    ).rejects.toMatchObject({ name: 'RotationMemberNotMemberError' });
    // The real safety property: nothing was persisted.
    const kinds = vi.mocked(dynamodb.send).mock.calls.map((c) => (c[0] as { kind: string }).kind);
    expect(kinds).not.toContain('Put');
  });

  it('stamps an anchor when one is not supplied, so the cycle has an origin', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const household = await import('../../../src/services/householdService.js');
    const { createSpace } = await import('../../../src/services/spaceService.js');
    vi.mocked(household.getMemberByUserId).mockResolvedValue({ userId: 'x', name: 'X' } as never);
    vi.mocked(dynamodb.send).mockResolvedValue({ Items: [] } as never);
    const space = await createSpace(
      { name: 'Balcony', environment: 'outside', rotation } as never,
      'hh',
      'sam'
    );
    expect(space.rotation?.memberIds).toEqual(['sam', 'priya']);
    expect(Number.isNaN(Date.parse(space.rotation!.anchor))).toBe(false);
  });

  it('reads a malformed or single-member stored rotation as NO rotation', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { getSpaces } = await import('../../../src/services/spaceService.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Items: [
        {
          id: 'a',
          householdId: 'hh',
          name: 'A',
          environment: 'inside',
          rotation: { memberIds: ['solo'], cadence: 'weekly', anchor: '2026-06-01T00:00:00.000Z' },
        },
        {
          id: 'b',
          householdId: 'hh',
          name: 'B',
          environment: 'inside',
          rotation: {
            memberIds: ['x', 'y'],
            cadence: 'fortnightly',
            anchor: '2026-06-01T00:00:00.000Z',
          },
        },
        {
          id: 'c',
          householdId: 'hh',
          name: 'C',
          environment: 'inside',
          rotation: { memberIds: ['x', 'y'], cadence: 'weekly', anchor: 'nonsense' },
        },
        {
          id: 'd',
          householdId: 'hh',
          name: 'D',
          environment: 'inside',
          rotation: {
            memberIds: ['x', 'y'],
            cadence: 'weekly',
            anchor: '2026-06-01T00:00:00.000Z',
          },
        },
      ],
    } as never);
    const spaces = await getSpaces('hh');
    expect(spaces.map((s) => s.rotation)).toEqual([
      null,
      null,
      null,
      { memberIds: ['x', 'y'], cadence: 'weekly', anchor: '2026-06-01T00:00:00.000Z' },
    ]);
  });

  it('derives whose turn it is only for spaces that HAVE a rotation', async () => {
    const { rotationTurns } = await import('../../../src/services/spaceService.js');
    const anchor = '2026-06-01T00:00:00.000Z';
    const spaces = [
      { id: 'plain', rotation: null, defaultCaregiverId: 'lee' },
      {
        id: 'rota',
        rotation: { memberIds: ['sam', 'priya'], cadence: 'weekly' as const, anchor },
        defaultCaregiverId: null,
      },
    ] as never;
    const ctx = {
      members: [
        { userId: 'sam', name: 'Sam' },
        { userId: 'priya', name: 'Priya' },
        { userId: 'lee', name: 'Lee' },
      ],
      vacations: [],
    };
    const turns = rotationTurns(spaces, ctx, new Date('2026-06-08T00:00:00.000Z'));
    expect(turns.has('plain')).toBe(false);
    expect(turns.get('rota')).toEqual({ turnUserId: 'priya', turnName: 'Priya' });
  });

  it('reports a rotating space with everyone away as a turn of nobody, not as no rotation', async () => {
    const { rotationTurns } = await import('../../../src/services/spaceService.js');
    const anchor = '2026-06-01T00:00:00.000Z';
    const spaces = [
      {
        id: 'rota',
        rotation: { memberIds: ['sam', 'priya'], cadence: 'weekly' as const, anchor },
        defaultCaregiverId: null,
      },
    ] as never;
    const away = (userId: string) => ({
      userId,
      coveredBy: 'lee',
      coveredByName: 'Lee',
      startDate: '2026-06-01T00:00:00.000Z',
      endDate: '2026-06-30T00:00:00.000Z',
    });
    const turns = rotationTurns(
      spaces,
      {
        members: [
          { userId: 'sam', name: 'Sam' },
          { userId: 'priya', name: 'Priya' },
        ],
        vacations: [away('sam'), away('priya')],
      },
      new Date('2026-06-08T00:00:00.000Z')
    );
    expect(turns.get('rota')).toEqual({ turnUserId: null, turnName: null });
  });
});
