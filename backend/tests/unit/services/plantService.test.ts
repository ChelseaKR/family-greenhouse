import { describe, it, expect, vi, beforeEach } from 'vitest';

const { s3Send } = vi.hoisted(() => ({ s3Send: vi.fn() }));

// Mock AWS SDK
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
  ListObjectsV2Command: vi.fn(function (input) {
    return { input, kind: 'ListObjectsV2' };
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

describe('plantService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('movePlants', () => {
    it('moves every requested plant in one transaction and returns refreshed rows', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb');
      const { movePlants } = await import('../../../src/services/plantService');
      vi.mocked(dynamodb.send)
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          Item: {
            id: 'p1',
            householdId: 'hh',
            name: 'Fern',
            species: null,
            location: null,
            spaceId: 'space-1',
            placementNote: 'top shelf',
            imageUrl: null,
            notes: null,
            createdAt: '',
            createdBy: 'u',
            updatedAt: '',
          },
        });

      const result = await movePlants('hh', {
        plantIds: ['p1'],
        spaceId: 'space-1',
        placementNote: 'top shelf',
      });

      expect(result).toHaveLength(1);
      const transaction = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
        kind: string;
        input: { TransactItems: Array<{ Update: Record<string, unknown> }> };
      };
      expect(transaction.kind).toBe('TransactWrite');
      expect(transaction.input.TransactItems).toHaveLength(1);
      expect(transaction.input.TransactItems[0].Update).toMatchObject({
        Key: { PK: 'HOUSEHOLD#hh', SK: 'PLANT#p1' },
        ConditionExpression: 'attribute_exists(PK)',
      });
    });
  });

  describe('createPlant', () => {
    // Shape of the TransactWrite payload createPlant sends.
    type CreateTransact = {
      kind: string;
      input: {
        TransactItems: [
          {
            Update: {
              UpdateExpression: string;
              ConditionExpression: string;
              ExpressionAttributeValues: Record<string, unknown>;
              Key: { PK: string; SK: string };
            };
          },
          { Put: { Item: Record<string, unknown> } },
        ];
      };
    };

    it('should create a plant with required fields via an atomic counter transact', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb');
      const { createPlant } = await import('../../../src/services/plantService');

      // 1st send: METADATA read (counter exists → no backfill query).
      vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: { plantCount: 3 } });
      // 2nd send: TransactWrite (counter increment + plant Put).
      vi.mocked(dynamodb.send).mockResolvedValueOnce({});

      const input = {
        name: 'Monstera',
        species: 'Monstera deliciosa',
        location: 'Living Room',
      };

      const result = await createPlant(input, 'household-123', 'user-456', 10);

      expect(result).toMatchObject({
        name: 'Monstera',
        species: 'Monstera deliciosa',
        location: 'Living Room',
        householdId: 'household-123',
        createdBy: 'user-456',
      });

      expect(result.id).toBeDefined();
      expect(result.createdAt).toBeDefined();
      expect(dynamodb.send).toHaveBeenCalledTimes(2);

      const transact = vi.mocked(dynamodb.send).mock.calls[1][0] as unknown as CreateTransact;
      expect(transact.kind).toBe('TransactWrite');
      const counterUpdate = transact.input.TransactItems[0].Update;
      expect(counterUpdate.Key).toEqual({ PK: 'HOUSEHOLD#household-123', SK: 'METADATA' });
      expect(counterUpdate.UpdateExpression).toBe(
        'SET plantCount = if_not_exists(plantCount, :base) + :one'
      );
      expect(counterUpdate.ConditionExpression).toBe(
        'attribute_exists(PK) AND (attribute_not_exists(plantCount) OR plantCount < :max)'
      );
      expect(counterUpdate.ExpressionAttributeValues).toEqual({
        ':base': 0,
        ':one': 1,
        ':max': 10,
      });
      expect(transact.input.TransactItems[1].Put.Item).toMatchObject({
        SK: `PLANT#${result.id}`,
        name: 'Monstera',
      });
    });

    it('should set null for optional fields if not provided', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb');
      const { createPlant } = await import('../../../src/services/plantService');

      vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: { plantCount: 0 } });
      vi.mocked(dynamodb.send).mockResolvedValueOnce({});

      const input = { name: 'Basic Plant' };

      const result = await createPlant(input, 'household-123', 'user-456', 10);

      expect(result.species).toBeNull();
      expect(result.location).toBeNull();
      expect(result.notes).toBeNull();
      expect(result.summerSpaceId).toBeNull();
      expect(result.winterSpaceId).toBeNull();
    });

    it('maps a TransactionCanceled cap-condition failure to PlanLimitError (concurrent creates)', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb');
      const { createPlant } = await import('../../../src/services/plantService');

      // Counter says 9 of 10 — two concurrent creates both pass any local
      // check, but DynamoDB serializes the transactions and the loser's
      // condition fails at commit time.
      vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: { plantCount: 10 } });
      vi.mocked(dynamodb.send).mockRejectedValueOnce(
        Object.assign(new Error('Transaction cancelled'), {
          name: 'TransactionCanceledException',
          CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
        })
      );

      await expect(createPlant({ name: 'Over cap' }, 'hh', 'u', 10)).rejects.toMatchObject({
        name: 'PlanLimitError',
      });
    });

    it('rethrows non-cap transaction failures untouched', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb');
      const { createPlant } = await import('../../../src/services/plantService');

      vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: { plantCount: 1 } });
      vi.mocked(dynamodb.send).mockRejectedValueOnce(
        Object.assign(new Error('throttled'), {
          name: 'TransactionCanceledException',
          CancellationReasons: [{ Code: 'TransactionConflict' }, { Code: 'None' }],
        })
      );

      await expect(createPlant({ name: 'x' }, 'hh', 'u', 10)).rejects.toMatchObject({
        name: 'TransactionCanceledException',
      });
    });

    it('lazily backfills plantCount from the real ACTIVE count on legacy rows', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb');
      const { createPlant } = await import('../../../src/services/plantService');

      // METADATA exists but predates the counter.
      vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: { id: 'hh', name: 'Legacy' } });
      // Backfill query: 2 active + 1 died → base must be 2 (cap counts ACTIVE).
      vi.mocked(dynamodb.send).mockResolvedValueOnce({
        Items: [
          { id: 'a', householdId: 'hh' },
          { id: 'b', householdId: 'hh', status: 'active' },
          { id: 'c', householdId: 'hh', status: 'died' },
        ],
      });
      vi.mocked(dynamodb.send).mockResolvedValueOnce({}); // TransactWrite

      await createPlant({ name: 'Third' }, 'hh', 'u', 10);

      const calls = vi.mocked(dynamodb.send).mock.calls;
      expect(calls).toHaveLength(3);
      const transact = calls[2][0] as unknown as CreateTransact;
      expect(transact.kind).toBe('TransactWrite');
      expect(transact.input.TransactItems[0].Update.ExpressionAttributeValues[':base']).toBe(2);
    });

    it('rejects with PlanLimitError before writing when a legacy row is already at cap', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb');
      const { createPlant } = await import('../../../src/services/plantService');

      vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: { id: 'hh' } }); // no plantCount
      vi.mocked(dynamodb.send).mockResolvedValueOnce({
        Items: Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, householdId: 'hh' })),
      });

      await expect(createPlant({ name: 'eleventh' }, 'hh', 'u', 10)).rejects.toMatchObject({
        name: 'PlanLimitError',
      });
      // Get + backfill query only — no TransactWrite was attempted.
      expect(vi.mocked(dynamodb.send).mock.calls).toHaveLength(2);
    });

    it('throws when the household METADATA row is missing', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb');
      const { createPlant } = await import('../../../src/services/plantService');

      vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: undefined });

      await expect(createPlant({ name: 'x' }, 'hh-gone', 'u', 10)).rejects.toThrow(/not found/);
    });
  });

  describe('getPlant', () => {
    it('should return plant if found', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb');
      const { getPlant } = await import('../../../src/services/plantService');

      const mockPlant = {
        id: 'plant-123',
        householdId: 'household-123',
        name: 'Monstera',
        species: 'Monstera deliciosa',
        location: 'Living Room',
        imageUrl: null,
        notes: null,
        createdAt: '2024-01-01T00:00:00Z',
        createdBy: 'user-456',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: mockPlant });

      const result = await getPlant('household-123', 'plant-123');

      // Service hydrates a `tags` array (defaulting to []), a
      // perenualSpeciesId (defaulting to null), the lifecycle status
      // (legacy rows with no status hydrate to 'active'), and the
      // propagation parent link (defaulting to null) so the response
      // shape stays stable for clients that always expect the fields.
      expect(result).toEqual({
        ...mockPlant,
        tags: [],
        perenualSpeciesId: null,
        status: 'active',
        statusChangedAt: null,
        parentPlantId: null,
        spaceId: null,
        placementNote: null,
        summerSpaceId: null,
        winterSpaceId: null,
      });
    });

    it('should return null if plant not found', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb');
      const { getPlant } = await import('../../../src/services/plantService');

      vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: undefined });

      const result = await getPlant('household-123', 'nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('deletePlant', () => {
    it('cascades to dependent tasks and completions', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb');
      const { deletePlant } = await import('../../../src/services/plantService');

      // 1st send: task query (one matching, one for a different plant).
      vi.mocked(dynamodb.send).mockResolvedValueOnce({
        Items: [
          {
            PK: 'HOUSEHOLD#hh',
            SK: 'TASK#t1',
            plantId: 'p1',
          },
          {
            PK: 'HOUSEHOLD#hh',
            SK: 'TASK#t2',
            plantId: 'other',
          },
        ],
      });
      // 2nd send: completion query for this plant.
      vi.mocked(dynamodb.send).mockResolvedValueOnce({
        Items: [
          {
            PK: 'HOUSEHOLD#hh#PLANT#p1',
            SK: 'COMPLETION#2025#abc',
          },
        ],
      });
      // 3rd send: BatchWrite (cascade tasks + completions).
      vi.mocked(dynamodb.send).mockResolvedValueOnce({});
      // 4th send: DeleteCommand for the plant row itself, ALL_OLD returns
      // the deleted attributes so the handler can use them for audit.
      vi.mocked(dynamodb.send).mockResolvedValueOnce({
        Attributes: {
          id: 'p1',
          householdId: 'hh',
          name: 'Pothos',
          createdAt: '',
          createdBy: '',
          updatedAt: '',
        },
      });
      // 5th send: plantCount decrement (deleted row has no status → active).
      vi.mocked(dynamodb.send).mockResolvedValueOnce({});

      await deletePlant('hh', 'p1');

      const calls = vi.mocked(dynamodb.send).mock.calls;
      expect(calls).toHaveLength(5);
      const decrement = calls[4][0] as unknown as {
        kind: string;
        input: { Key: { SK: string }; UpdateExpression: string; ConditionExpression: string };
      };
      expect(decrement.kind).toBe('Update');
      expect(decrement.input.Key.SK).toBe('METADATA');
      expect(decrement.input.UpdateExpression).toBe(
        'SET plantCount = if_not_exists(plantCount, :one) - :one'
      );
      // Floor at 0: refuses to go negative (and tolerates a missing counter).
      expect(decrement.input.ConditionExpression).toBe(
        'attribute_exists(PK) AND (attribute_not_exists(plantCount) OR plantCount > :zero)'
      );
      const batch = calls[2][0] as unknown as {
        input: { RequestItems: Record<string, Array<{ DeleteRequest: { Key: { SK: string } } }>> };
      };
      const tableName = Object.keys(batch.input.RequestItems)[0];
      const sks = batch.input.RequestItems[tableName].map((r) => r.DeleteRequest.Key.SK);
      // task t1 (matching plant) and the completion ride in the batch.
      expect(sks).toContain('TASK#t1');
      expect(sks).toContain('COMPLETION#2025#abc');
      // The plant row itself is no longer in the batch — it gets a separate
      // conditional Delete so we can detect "didn't exist" atomically.
      expect(sks).not.toContain('PLANT#p1');
      // task t2 belongs to a different plant — must NOT be deleted.
      expect(sks).not.toContain('TASK#t2');
    });

    it('chunks BatchWrite at 25 keys per request', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb');
      const { deletePlant } = await import('../../../src/services/plantService');
      // 30 task rows for the same plant.
      vi.mocked(dynamodb.send).mockResolvedValueOnce({
        Items: Array.from({ length: 30 }, (_, i) => ({
          PK: 'HOUSEHOLD#hh',
          SK: `TASK#t${i}`,
          plantId: 'p1',
        })),
      });
      vi.mocked(dynamodb.send).mockResolvedValueOnce({ Items: [] });
      vi.mocked(dynamodb.send).mockResolvedValue({
        Attributes: {
          id: 'p1',
          householdId: 'hh',
          name: 'p',
          createdAt: '',
          createdBy: '',
          updatedAt: '',
        },
      });
      await deletePlant('hh', 'p1');
      // 2 query calls + 2 batch calls (30 tasks chunked 25+5) + 1 plant
      // Delete + 1 plantCount decrement.
      expect(vi.mocked(dynamodb.send).mock.calls).toHaveLength(6);
    });

    it('does NOT decrement plantCount when the deleted plant had already left active', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb');
      const { deletePlant } = await import('../../../src/services/plantService');
      vi.mocked(dynamodb.send).mockResolvedValueOnce({ Items: [] }); // tasks
      vi.mocked(dynamodb.send).mockResolvedValueOnce({ Items: [] }); // completions
      vi.mocked(dynamodb.send).mockResolvedValueOnce({
        Attributes: {
          id: 'p1',
          householdId: 'hh',
          name: 'p',
          status: 'died', // counter was decremented at the status transition
          createdAt: '',
          createdBy: '',
          updatedAt: '',
        },
      });
      const deleted = await deletePlant('hh', 'p1');
      expect(deleted?.status).toBe('died');
      // tasks query + completions query + plant Delete — no counter Update.
      expect(vi.mocked(dynamodb.send).mock.calls).toHaveLength(3);
    });

    it('swallows the decrement floor (ConditionalCheckFailed) so the delete still succeeds', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb');
      const { deletePlant } = await import('../../../src/services/plantService');
      vi.mocked(dynamodb.send).mockResolvedValueOnce({ Items: [] }); // tasks
      vi.mocked(dynamodb.send).mockResolvedValueOnce({ Items: [] }); // completions
      vi.mocked(dynamodb.send).mockResolvedValueOnce({
        Attributes: {
          id: 'p1',
          householdId: 'hh',
          name: 'p',
          createdAt: '',
          createdBy: '',
          updatedAt: '',
        },
      });
      // Counter already at 0 (drift) — must not turn the delete into an error.
      vi.mocked(dynamodb.send).mockRejectedValueOnce(
        Object.assign(new Error('floor'), { name: 'ConditionalCheckFailedException' })
      );
      const deleted = await deletePlant('hh', 'p1');
      expect(deleted?.id).toBe('p1');
    });

    it('does not touch S3 when IMAGES_BUCKET is unset (dev/test default)', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb');
      const { deletePlant } = await import('../../../src/services/plantService');
      vi.mocked(dynamodb.send).mockResolvedValueOnce({ Items: [] }); // tasks
      vi.mocked(dynamodb.send).mockResolvedValueOnce({ Items: [] }); // completions
      vi.mocked(dynamodb.send).mockResolvedValueOnce({
        Attributes: {
          id: 'p1',
          householdId: 'hh',
          name: 'p',
          createdAt: '',
          createdBy: '',
          updatedAt: '',
        },
      });
      await deletePlant('hh', 'p1');
      expect(s3Send).not.toHaveBeenCalled();
    });

    it("sweeps the plant's S3 objects when IMAGES_BUCKET is configured", async () => {
      process.env.IMAGES_BUCKET = 'imgs-bucket';
      try {
        const { dynamodb } = await import('../../../src/utils/dynamodb');
        const { deletePlant } = await import('../../../src/services/plantService');
        vi.mocked(dynamodb.send).mockResolvedValueOnce({ Items: [] }); // tasks
        vi.mocked(dynamodb.send).mockResolvedValueOnce({ Items: [] }); // completions
        vi.mocked(dynamodb.send).mockResolvedValueOnce({
          Attributes: {
            id: 'p1',
            householdId: 'hh',
            name: 'p',
            createdAt: '',
            createdBy: '',
            updatedAt: '',
          },
        }); // plant row delete
        // S3: one page listing one object, then the delete call.
        s3Send.mockResolvedValueOnce({
          Contents: [{ Key: 'plants/hh/p1/photo.jpg' }],
          IsTruncated: false,
        });
        s3Send.mockResolvedValueOnce({});

        await deletePlant('hh', 'p1');

        const listCall = s3Send.mock.calls.find(
          (c) => (c[0] as { kind: string }).kind === 'ListObjectsV2'
        );
        expect((listCall![0] as { input: { Prefix: string; Bucket: string } }).input).toMatchObject(
          {
            Bucket: 'imgs-bucket',
            Prefix: 'plants/hh/p1/',
          }
        );
        const delCall = s3Send.mock.calls.find(
          (c) => (c[0] as { kind: string }).kind === 'DeleteObjects'
        );
        expect(
          (delCall![0] as { input: { Delete: { Objects: { Key: string }[] } } }).input.Delete
            .Objects
        ).toEqual([{ Key: 'plants/hh/p1/photo.jpg' }]);
      } finally {
        delete process.env.IMAGES_BUCKET;
      }
    });
  });

  describe('updatePlant', () => {
    type TransitionTransact = {
      kind: string;
      input: {
        TransactItems: [
          {
            Update: {
              Key: { SK: string };
              ConditionExpression: string;
              ExpressionAttributeValues: Record<string, unknown>;
            };
          },
          {
            Update: {
              Key: { SK: string };
              UpdateExpression: string;
            };
          },
        ];
      };
    };

    const plantRow = (status?: string) => ({
      Item: {
        id: 'p1',
        householdId: 'hh',
        name: 'Pothos',
        species: null,
        location: null,
        imageUrl: null,
        notes: null,
        ...(status ? { status } : {}),
        createdAt: '',
        createdBy: '',
        updatedAt: '',
      },
    });

    it('non-status updates use a single conditional UpdateCommand (no counter reads)', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb');
      const { updatePlant } = await import('../../../src/services/plantService');
      vi.mocked(dynamodb.send).mockResolvedValueOnce({ Attributes: plantRow('active').Item });
      const result = await updatePlant('hh', 'p1', { name: 'Renamed' }, 10);
      expect(result?.id).toBe('p1');
      const calls = vi.mocked(dynamodb.send).mock.calls;
      expect(calls).toHaveLength(1);
      expect((calls[0][0] as unknown as { kind: string }).kind).toBe('Update');
    });

    it('writes and returns both seasonal home IDs as ordinary plant fields', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb');
      const { updatePlant } = await import('../../../src/services/plantService');
      vi.mocked(dynamodb.send).mockResolvedValueOnce({
        Attributes: {
          ...plantRow('active').Item,
          summerSpaceId: 'summer-space',
          winterSpaceId: 'winter-space',
        },
      });

      const result = await updatePlant(
        'hh',
        'p1',
        { summerSpaceId: 'summer-space', winterSpaceId: 'winter-space' },
        10
      );

      expect(result).toMatchObject({
        summerSpaceId: 'summer-space',
        winterSpaceId: 'winter-space',
      });
      const update = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
        input: {
          UpdateExpression: string;
          ExpressionAttributeValues: Record<string, unknown>;
        };
      };
      expect(update.input.UpdateExpression).toContain('#summerSpaceId = :summerSpaceId');
      expect(update.input.UpdateExpression).toContain('#winterSpaceId = :winterSpaceId');
      expect(update.input.ExpressionAttributeValues).toMatchObject({
        ':summerSpaceId': 'summer-space',
        ':winterSpaceId': 'winter-space',
      });
    });

    it('active → died decrements plantCount in the same transaction as the status write', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb');
      const { updatePlant } = await import('../../../src/services/plantService');
      vi.mocked(dynamodb.send).mockResolvedValueOnce(plantRow('active')); // read current
      vi.mocked(dynamodb.send).mockResolvedValueOnce({}); // TransactWrite
      vi.mocked(dynamodb.send).mockResolvedValueOnce(plantRow('died')); // re-read

      const result = await updatePlant('hh', 'p1', { status: 'died' }, 10);
      expect(result?.status).toBe('died');

      const transact = vi.mocked(dynamodb.send).mock.calls[1][0] as unknown as TransitionTransact;
      expect(transact.kind).toBe('TransactWrite');
      const [plantUpdate, counterUpdate] = transact.input.TransactItems;
      // Conditioned on the status we read — tolerating legacy rows that
      // never had a status attribute (they hydrate to 'active').
      expect(plantUpdate.Update.Key.SK).toBe('PLANT#p1');
      expect(plantUpdate.Update.ConditionExpression).toBe(
        'attribute_exists(PK) AND (attribute_not_exists(#status) OR #status = :oldStatus)'
      );
      expect(plantUpdate.Update.ExpressionAttributeValues[':oldStatus']).toBe('active');
      expect(counterUpdate.Update.Key.SK).toBe('METADATA');
      expect(counterUpdate.Update.UpdateExpression).toBe(
        'SET plantCount = if_not_exists(plantCount, :one) - :one'
      );
    });

    it('active → archived frees a cap slot without deleting the plant', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb');
      const { updatePlant } = await import('../../../src/services/plantService');
      vi.mocked(dynamodb.send).mockResolvedValueOnce(plantRow('active'));
      vi.mocked(dynamodb.send).mockResolvedValueOnce({});
      vi.mocked(dynamodb.send).mockResolvedValueOnce(plantRow('archived'));

      const result = await updatePlant('hh', 'p1', { status: 'archived' }, 10);

      expect(result?.status).toBe('archived');
      const transact = vi.mocked(dynamodb.send).mock.calls[1][0] as unknown as TransitionTransact;
      expect(transact.input.TransactItems[1].Update.UpdateExpression).toBe(
        'SET plantCount = if_not_exists(plantCount, :one) - :one'
      );
    });

    it('died → active increments plantCount (returning to the capped population)', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb');
      const { updatePlant } = await import('../../../src/services/plantService');
      vi.mocked(dynamodb.send).mockResolvedValueOnce(plantRow('died'));
      vi.mocked(dynamodb.send).mockResolvedValueOnce({});
      vi.mocked(dynamodb.send).mockResolvedValueOnce(plantRow('active'));

      const result = await updatePlant('hh', 'p1', { status: 'active' }, 10);
      expect(result?.status).toBe('active');

      const transact = vi.mocked(dynamodb.send).mock.calls[1][0] as unknown as TransitionTransact;
      const [plantUpdate, counterUpdate] = transact.input.TransactItems;
      expect(plantUpdate.Update.ConditionExpression).toBe(
        'attribute_exists(PK) AND #status = :oldStatus'
      );
      expect(plantUpdate.Update.ExpressionAttributeValues[':oldStatus']).toBe('died');
      expect(counterUpdate.Update.UpdateExpression).toBe(
        'SET plantCount = if_not_exists(plantCount, :zero) + :one'
      );
      // Reactivation is cap-checked exactly like createPlant.
      expect(counterUpdate.Update.ConditionExpression).toBe(
        'attribute_exists(PK) AND (attribute_not_exists(plantCount) OR plantCount < :max)'
      );
      expect(counterUpdate.Update.ExpressionAttributeValues[':max']).toBe(10);
    });

    it('archived → active restores the plant through the cap-checked transaction', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb');
      const { updatePlant } = await import('../../../src/services/plantService');
      vi.mocked(dynamodb.send).mockResolvedValueOnce(plantRow('archived'));
      vi.mocked(dynamodb.send).mockResolvedValueOnce({});
      vi.mocked(dynamodb.send).mockResolvedValueOnce(plantRow('active'));

      const result = await updatePlant('hh', 'p1', { status: 'active' }, 10);

      expect(result?.status).toBe('active');
      const transact = vi.mocked(dynamodb.send).mock.calls[1][0] as unknown as TransitionTransact;
      expect(transact.input.TransactItems[1].Update.ConditionExpression).toContain(
        'plantCount < :max'
      );
    });

    it('rejects reactivation with PlanLimitError when the household is already at its plant cap', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb');
      const { updatePlant, PlanLimitError } = await import('../../../src/services/plantService');
      vi.mocked(dynamodb.send).mockResolvedValueOnce(plantRow('died')); // read current
      vi.mocked(dynamodb.send).mockRejectedValueOnce(
        Object.assign(new Error('cancelled'), {
          name: 'TransactionCanceledException',
          // reasons[0] (plant status write) succeeds; reasons[1] (the
          // METADATA counter's cap condition) is the one that fails.
          CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
        })
      );

      await expect(updatePlant('hh', 'p1', { status: 'active' }, 10)).rejects.toThrow(
        PlanLimitError
      );
      // Must NOT retry a genuine cap failure the way it retries a status race.
      expect(vi.mocked(dynamodb.send).mock.calls).toHaveLength(2);
    });

    it('died → gave_away does not move the counter (never left the non-active population)', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb');
      const { updatePlant } = await import('../../../src/services/plantService');
      vi.mocked(dynamodb.send).mockResolvedValueOnce(plantRow('died')); // read current
      vi.mocked(dynamodb.send).mockResolvedValueOnce({ Attributes: plantRow('gave_away').Item });

      const result = await updatePlant('hh', 'p1', { status: 'gave_away' }, 10);
      expect(result?.status).toBe('gave_away');
      const calls = vi.mocked(dynamodb.send).mock.calls;
      expect(calls).toHaveLength(2);
      expect((calls[1][0] as unknown as { kind: string }).kind).toBe('Update');
    });

    it('does not rewrite timestamps for an idempotent status retry', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb');
      const { updatePlant } = await import('../../../src/services/plantService');
      vi.mocked(dynamodb.send).mockResolvedValueOnce(plantRow('archived'));

      const result = await updatePlant('hh', 'p1', { status: 'archived' }, 10);

      expect(result?.status).toBe('archived');
      expect(vi.mocked(dynamodb.send)).toHaveBeenCalledTimes(1);
    });

    it('applies ordinary edits on a status retry without rewriting lifecycle timestamps', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb');
      const { updatePlant } = await import('../../../src/services/plantService');
      vi.mocked(dynamodb.send).mockResolvedValueOnce(plantRow('archived'));
      vi.mocked(dynamodb.send).mockResolvedValueOnce({
        Attributes: { ...plantRow('archived').Item, name: 'Renamed' },
      });

      const result = await updatePlant('hh', 'p1', { status: 'archived', name: 'Renamed' }, 10);

      expect(result?.name).toBe('Renamed');
      const update = vi.mocked(dynamodb.send).mock.calls[1][0] as unknown as {
        input: { UpdateExpression: string };
      };
      expect(update.input.UpdateExpression).toContain('#name = :name');
      expect(update.input.UpdateExpression).not.toContain('#status');
    });

    it('retries once after losing a concurrent status-transition race', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb');
      const { updatePlant } = await import('../../../src/services/plantService');
      // 1st attempt: read active, transact loses the :oldStatus condition
      // (someone else marked it died in between).
      vi.mocked(dynamodb.send).mockResolvedValueOnce(plantRow('active'));
      vi.mocked(dynamodb.send).mockRejectedValueOnce(
        Object.assign(new Error('cancelled'), {
          name: 'TransactionCanceledException',
          CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
        })
      );
      // 2nd attempt: re-read sees died → died→died is an idempotent no-op.
      vi.mocked(dynamodb.send).mockResolvedValueOnce(plantRow('died'));

      const result = await updatePlant('hh', 'p1', { status: 'died' }, 10);
      expect(result?.status).toBe('died');
      expect(vi.mocked(dynamodb.send).mock.calls).toHaveLength(3);
    });

    it('returns null when the plant disappeared before a status transition', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb');
      const { updatePlant } = await import('../../../src/services/plantService');
      vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: undefined });
      expect(await updatePlant('hh', 'gone', { status: 'died' }, 10)).toBeNull();
    });
  });

  describe('getPlants', () => {
    it('should return all plants for a household', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb');
      const { getPlants } = await import('../../../src/services/plantService');

      const mockPlants = [
        { id: 'plant-1', name: 'Plant 1', householdId: 'household-123' },
        { id: 'plant-2', name: 'Plant 2', householdId: 'household-123' },
      ];

      vi.mocked(dynamodb.send).mockResolvedValueOnce({ Items: mockPlants });

      const result = await getPlants('household-123');

      expect(result).toHaveLength(2);
    });

    it('should return empty array if no plants found', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb');
      const { getPlants } = await import('../../../src/services/plantService');

      vi.mocked(dynamodb.send).mockResolvedValueOnce({ Items: [] });

      const result = await getPlants('household-123');

      expect(result).toEqual([]);
    });

    it('follows LastEvaluatedKey so large collections are not truncated at one page', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb');
      const { getPlants } = await import('../../../src/services/plantService');

      // Paid plans allow 500–5,000 plants; the old single-page query
      // silently dropped everything after the first 200.
      vi.mocked(dynamodb.send)
        .mockResolvedValueOnce({
          Items: Array.from({ length: 200 }, (_, i) => ({
            id: `p${i}`,
            name: `Plant ${i}`,
            householdId: 'h',
          })),
          LastEvaluatedKey: { PK: 'HOUSEHOLD#h', SK: 'PLANT#p199' },
        })
        .mockResolvedValueOnce({
          Items: Array.from({ length: 50 }, (_, i) => ({
            id: `p${200 + i}`,
            name: `Plant ${200 + i}`,
            householdId: 'h',
          })),
        });

      const result = await getPlants('h');
      expect(result).toHaveLength(250);
      const calls = vi.mocked(dynamodb.send).mock.calls;
      expect(calls).toHaveLength(2);
      const second = calls[1][0] as unknown as {
        input: { ExclusiveStartKey: Record<string, string> };
      };
      expect(second.input.ExclusiveStartKey).toEqual({ PK: 'HOUSEHOLD#h', SK: 'PLANT#p199' });
    });

    it('filters by lifecycle status (legacy rows count as active)', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb');
      const { getPlants } = await import('../../../src/services/plantService');

      const rows = [
        { id: 'a', name: 'Active', householdId: 'h' }, // no status → active
        { id: 'b', name: 'Explicit', householdId: 'h', status: 'active' },
        { id: 'c', name: 'Dead', householdId: 'h', status: 'died' },
        { id: 'd', name: 'Gifted', householdId: 'h', status: 'gave_away' },
      ];
      // One mock per call (default active, then past, then all).
      vi.mocked(dynamodb.send)
        .mockResolvedValueOnce({ Items: rows })
        .mockResolvedValueOnce({ Items: rows })
        .mockResolvedValueOnce({ Items: rows });

      expect((await getPlants('h')).map((p) => p.id)).toEqual(['a', 'b']);
      expect((await getPlants('h', 'past')).map((p) => p.id)).toEqual(['c', 'd']);
      expect((await getPlants('h', 'all')).map((p) => p.id)).toEqual(['a', 'b', 'c', 'd']);
    });
  });
});
