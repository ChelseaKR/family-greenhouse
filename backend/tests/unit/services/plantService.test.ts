import { describe, it, expect, vi, beforeEach } from 'vitest';

const { s3Send } = vi.hoisted(() => ({ s3Send: vi.fn() }));

// Mock AWS SDK
vi.mock('@aws-sdk/lib-dynamodb', () => ({
  PutCommand: vi.fn((input) => ({ input, kind: 'Put' })),
  GetCommand: vi.fn((input) => ({ input, kind: 'Get' })),
  QueryCommand: vi.fn((input) => ({ input, kind: 'Query' })),
  DeleteCommand: vi.fn((input) => ({ input, kind: 'Delete' })),
  UpdateCommand: vi.fn((input) => ({ input, kind: 'Update' })),
  BatchWriteCommand: vi.fn((input) => ({ input, kind: 'BatchWrite' })),
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(() => ({ send: s3Send })),
  ListObjectsV2Command: vi.fn((input) => ({ input, kind: 'ListObjectsV2' })),
  DeleteObjectsCommand: vi.fn((input) => ({ input, kind: 'DeleteObjects' })),
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

  describe('createPlant', () => {
    it('should create a plant with required fields', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb');
      const { createPlant } = await import('../../../src/services/plantService');

      vi.mocked(dynamodb.send).mockResolvedValueOnce({});

      const input = {
        name: 'Monstera',
        species: 'Monstera deliciosa',
        location: 'Living Room',
      };

      const result = await createPlant(input, 'household-123', 'user-456');

      expect(result).toMatchObject({
        name: 'Monstera',
        species: 'Monstera deliciosa',
        location: 'Living Room',
        householdId: 'household-123',
        createdBy: 'user-456',
      });

      expect(result.id).toBeDefined();
      expect(result.createdAt).toBeDefined();
      expect(dynamodb.send).toHaveBeenCalledTimes(1);
    });

    it('should set null for optional fields if not provided', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb');
      const { createPlant } = await import('../../../src/services/plantService');

      vi.mocked(dynamodb.send).mockResolvedValueOnce({});

      const input = { name: 'Basic Plant' };

      const result = await createPlant(input, 'household-123', 'user-456');

      expect(result.species).toBeNull();
      expect(result.location).toBeNull();
      expect(result.notes).toBeNull();
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

      // Service hydrates a `tags` array (defaulting to []) and a
      // perenualSpeciesId (defaulting to null) so the response shape stays
      // stable for clients that always expect the fields.
      expect(result).toEqual({ ...mockPlant, tags: [], perenualSpeciesId: null });
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
      // 3rd send: BatchWrite.
      vi.mocked(dynamodb.send).mockResolvedValueOnce({});

      await deletePlant('hh', 'p1');

      const calls = vi.mocked(dynamodb.send).mock.calls;
      expect(calls).toHaveLength(3);
      const batch = calls[2][0] as unknown as {
        input: { RequestItems: Record<string, Array<{ DeleteRequest: { Key: { SK: string } } }>> };
      };
      const tableName = Object.keys(batch.input.RequestItems)[0];
      const sks = batch.input.RequestItems[tableName].map((r) => r.DeleteRequest.Key.SK);
      // task t1 (matching plant), the completion, and the plant row itself.
      expect(sks).toContain('TASK#t1');
      expect(sks).toContain('COMPLETION#2025#abc');
      expect(sks).toContain('PLANT#p1');
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
      vi.mocked(dynamodb.send).mockResolvedValue({});
      await deletePlant('hh', 'p1');
      // 2 query calls + 2 batch calls (30 + 1 plant row = 31 -> 25 + 6).
      expect(vi.mocked(dynamodb.send).mock.calls).toHaveLength(4);
    });

    it('does not touch S3 when IMAGES_BUCKET is unset (dev/test default)', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb');
      const { deletePlant } = await import('../../../src/services/plantService');
      vi.mocked(dynamodb.send).mockResolvedValueOnce({ Items: [] }); // tasks
      vi.mocked(dynamodb.send).mockResolvedValueOnce({ Items: [] }); // completions
      vi.mocked(dynamodb.send).mockResolvedValueOnce({}); // batch delete (plant row)
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
        vi.mocked(dynamodb.send).mockResolvedValueOnce({}); // batch delete (plant row)
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
  });
});
