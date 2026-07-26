import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  QueryCommand: vi.fn(function (input) {
    return { input, kind: 'Query' };
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

describe('account cleanup', () => {
  beforeEach(() => vi.clearAllMocks());

  it('anonymizes retained history and clears active task assignments', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockImplementation(async (raw) => {
      const command = raw as unknown as {
        kind: string;
        input: {
          IndexName?: string;
          Key?: Record<string, string>;
          KeyConditionExpression?: string;
          ExpressionAttributeValues?: Record<string, string>;
        };
      };
      if (command.kind !== 'Query') return {} as never;
      if (command.input.IndexName === 'GSI1') {
        if (command.input.ExpressionAttributeValues?.[':pk'] === 'HOUSEHOLD#hh#SITTER') {
          return {
            Items: [
              {
                PK: 'SITTER#secret',
                SK: 'METADATA',
                createdBy: 'u1',
              },
            ],
          } as never;
        }
        return {
          Items: [
            {
              PK: 'HOUSEHOLD#hh#ACTIVITY',
              SK: 'EVENT#1',
              entityType: 'ActivityEvent',
              actorId: 'u1',
            },
            {
              PK: 'HOUSEHOLD#hh#PLANT#p1',
              SK: 'COMPLETION#1',
              entityType: 'TaskCompletion',
              completedBy: 'u1',
            },
          ],
        } as never;
      }
      if (command.input.KeyConditionExpression?.includes('begins_with')) {
        return {
          Items: [
            {
              PK: 'HOUSEHOLD#hh#PLANT#p1',
              SK: 'PHOTO#1',
              entityType: 'PlantPhoto',
              uploadedBy: 'u1',
            },
          ],
        } as never;
      }
      return {
        Items: [
          {
            PK: 'HOUSEHOLD#hh',
            SK: 'PLANT#p1',
            entityType: 'Plant',
            id: 'p1',
          },
          {
            PK: 'HOUSEHOLD#hh',
            SK: 'TASK#t1',
            entityType: 'Task',
            createdBy: 'u1',
            assignedTo: 'u1',
          },
          {
            PK: 'HOUSEHOLD#hh',
            SK: 'VACATION#u2',
            entityType: 'VacationWindow',
            userId: 'u2',
            coveredBy: 'u1',
          },
          {
            PK: 'HOUSEHOLD#hh',
            SK: 'SPACE#s1',
            entityType: 'PlantSpace',
            defaultCaregiverId: 'u1',
          },
        ],
      } as never;
    });

    const { anonymizeUserInHousehold } = await import('../../../src/services/accountCleanup.js');
    await anonymizeUserInHousehold('hh', 'u1');

    const updates = vi
      .mocked(dynamodb.send)
      .mock.calls.map((call) => call[0] as unknown as { kind: string; input: Record<string, any> })
      .filter((command) => command.kind === 'Update');
    expect(updates).toHaveLength(6);
    const taskUpdate = updates.find((update) => update.input.Key?.SK === 'TASK#t1');
    expect(taskUpdate?.input.UpdateExpression).toContain('#createdBy = :deletedId');
    expect(taskUpdate?.input.UpdateExpression).toContain('#assignedTo = :null');
    expect(taskUpdate?.input.UpdateExpression).toContain('#assignmentSource = :null');
    expect(taskUpdate?.input.UpdateExpression).toContain('REMOVE GSI2PK, GSI2SK');
    const spaceUpdate = updates.find((update) => update.input.Key?.SK === 'SPACE#s1');
    expect(spaceUpdate?.input.UpdateExpression).toContain('#defaultCaregiverId = :null');
    const photoUpdate = updates.find((update) => update.input.Key?.SK === 'PHOTO#1');
    expect(photoUpdate?.input.UpdateExpression).toBe('SET #uploadedBy = :deletedId');
    const sitterUpdate = updates.find((update) => update.input.Key?.PK === 'SITTER#secret');
    expect(sitterUpdate?.input.UpdateExpression).toBe('SET #createdBy = :deletedId');
    const activityUpdate = updates.find((update) => update.input.Key?.SK === 'EVENT#1');
    expect(activityUpdate?.input.ExpressionAttributeValues).toMatchObject({
      ':deletedId': 'deleted-user',
      ':deletedName': 'Former member',
    });
    const completionUpdate = updates.find((update) => update.input.Key?.SK === 'COMPLETION#1');
    expect(completionUpdate?.input.ExpressionAttributeValues).toMatchObject({
      ':deletedId': 'deleted-user',
      ':deletedName': 'Former member',
    });
    const deletes = vi
      .mocked(dynamodb.send)
      .mock.calls.map((call) => call[0] as unknown as { kind: string; input: Record<string, any> })
      .filter((command) => command.kind === 'Delete');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].input.Key).toEqual({ PK: 'HOUSEHOLD#hh', SK: 'VACATION#u2' });
  });

  it('deletes every page of the user partition, including notification markers', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    let queryPage = 0;
    vi.mocked(dynamodb.send).mockImplementation(async (raw) => {
      const command = raw as unknown as { kind: string };
      if (command.kind !== 'Query') return {} as never;
      queryPage += 1;
      return (
        queryPage === 1
          ? {
              Items: [
                { PK: 'USER#u1', SK: 'PREFS' },
                { PK: 'USER#u1', SK: 'WELCOME#FIRST_HOUSEHOLD' },
              ],
              LastEvaluatedKey: { PK: 'USER#u1', SK: 'WELCOME#FIRST_HOUSEHOLD' },
            }
          : {
              Items: [{ PK: 'USER#u1', SK: 'DIGEST#2026-W30#HOUSEHOLD#hh' }],
            }
      ) as never;
    });

    const { deleteUserScopedData } = await import('../../../src/services/accountCleanup.js');
    await deleteUserScopedData('u1');

    const commands = vi.mocked(dynamodb.send).mock.calls.map(
      ([command]) =>
        command as unknown as {
          kind: string;
          input: {
            ExclusiveStartKey?: Record<string, string>;
            Key?: Record<string, string>;
            ProjectionExpression?: string;
          };
        }
    );
    const queries = commands.filter((command) => command.kind === 'Query');
    expect(queries).toHaveLength(2);
    expect(queries[0].input.ProjectionExpression).toBe('PK, SK');
    expect(queries[1].input.ExclusiveStartKey).toEqual({
      PK: 'USER#u1',
      SK: 'WELCOME#FIRST_HOUSEHOLD',
    });
    expect(
      commands.filter((command) => command.kind === 'Delete').map((command) => command.input.Key)
    ).toEqual([
      { PK: 'USER#u1', SK: 'PREFS' },
      { PK: 'USER#u1', SK: 'WELCOME#FIRST_HOUSEHOLD' },
      { PK: 'USER#u1', SK: 'DIGEST#2026-W30#HOUSEHOLD#hh' },
    ]);
  });

  it('deletes sitter credentials and every abandoned-household partition row', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockImplementation(async (raw) => {
      const command = raw as unknown as {
        kind: string;
        input: { IndexName?: string; ExpressionAttributeValues?: Record<string, string> };
      };
      if (command.kind !== 'Query') return {} as never;
      const pk = command.input.ExpressionAttributeValues?.[':pk'];
      if (command.input.IndexName === 'GSI1') {
        return {
          Items: [{ PK: 'SITTER#secret', SK: 'METADATA' }],
        } as never;
      }
      if (pk === 'HOUSEHOLD#hh#ACTIVITY') {
        return {
          Items: [{ PK: 'HOUSEHOLD#hh#ACTIVITY', SK: 'EVENT#1' }],
        } as never;
      }
      return {
        Items: [
          { PK: 'HOUSEHOLD#hh', SK: 'METADATA' },
          { PK: 'HOUSEHOLD#hh', SK: 'SPACE#s1' },
          { PK: 'HOUSEHOLD#hh', SK: 'TASK#t1' },
          { PK: 'HOUSEHOLD#hh', SK: 'MEMBER#u1' },
        ],
      } as never;
    });

    const { deleteAbandonedHouseholdData } =
      await import('../../../src/services/accountCleanup.js');
    await deleteAbandonedHouseholdData('hh');

    const commands = vi.mocked(dynamodb.send).mock.calls.map(
      ([command]) =>
        command as unknown as {
          kind: string;
          input: {
            IndexName?: string;
            ProjectionExpression?: string;
            Key?: Record<string, string>;
          };
        }
    );
    expect(commands.filter((command) => command.kind === 'Query')).toHaveLength(3);
    expect(
      commands.filter((command) => command.kind === 'Delete').map((command) => command.input.Key)
    ).toEqual(
      expect.arrayContaining([
        { PK: 'SITTER#secret', SK: 'METADATA' },
        { PK: 'HOUSEHOLD#hh#ACTIVITY', SK: 'EVENT#1' },
        { PK: 'HOUSEHOLD#hh', SK: 'METADATA' },
        { PK: 'HOUSEHOLD#hh', SK: 'SPACE#s1' },
        { PK: 'HOUSEHOLD#hh', SK: 'TASK#t1' },
        { PK: 'HOUSEHOLD#hh', SK: 'MEMBER#u1' },
      ])
    );
    expect(commands.filter((command) => command.kind === 'Delete').at(-1)?.input.Key).toEqual({
      PK: 'HOUSEHOLD#hh',
      SK: 'MEMBER#u1',
    });
    expect(
      commands
        .filter((command) => command.kind === 'Query')
        .every((command) => command.input.ProjectionExpression === 'PK, SK')
    ).toBe(true);
  });
});
