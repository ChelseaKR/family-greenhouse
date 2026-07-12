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
        };
      };
      if (command.kind !== 'Query') return {} as never;
      if (command.input.IndexName === 'GSI1') {
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
        ],
      } as never;
    });

    const { anonymizeUserInHousehold } = await import('../../../src/services/accountCleanup.js');
    await anonymizeUserInHousehold('hh', 'u1');

    const updates = vi
      .mocked(dynamodb.send)
      .mock.calls.map((call) => call[0] as unknown as { kind: string; input: Record<string, any> })
      .filter((command) => command.kind === 'Update');
    expect(updates).toHaveLength(4);
    expect(updates[0].input.UpdateExpression).toContain('#createdBy = :deletedId');
    expect(updates[0].input.UpdateExpression).toContain('#assignedTo = :null');
    expect(updates[0].input.UpdateExpression).toContain('REMOVE GSI2PK, GSI2SK');
    expect(updates[1].input.UpdateExpression).toBe('SET #uploadedBy = :deletedId');
    expect(updates[2].input.ExpressionAttributeValues).toMatchObject({
      ':deletedId': 'deleted-user',
      ':deletedName': 'Former member',
    });
    expect(updates[3].input.ExpressionAttributeValues).toMatchObject({
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
});
