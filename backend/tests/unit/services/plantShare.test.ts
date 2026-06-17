/**
 * Unit tests for the propagation-lineage and cutting-share additions to
 * services/plantService.ts: snapshot semantics, share TTL/expiry, and the
 * filter-the-household lineage assembly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    return { send: vi.fn() };
  }),
  ListObjectsV2Command: vi.fn(function (input) {
    return { input, kind: 'ListObjectsV2' };
  }),
  DeleteObjectsCommand: vi.fn(function (input) {
    return { input, kind: 'DeleteObjects' };
  }),
}));

vi.mock('../../../src/utils/dynamodb', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));

const plantRow = {
  id: 'plant-1',
  householdId: 'hh-1',
  name: 'Mother Monstera',
  species: 'Monstera deliciosa',
  location: 'Kitchen',
  imageUrl: 'https://assets.example/plants/hh-1/plant-1/a.jpg',
  notes: 'east window',
  status: 'active',
  tags: ['tropical', 'gift'],
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: 'user-1',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('plantService — shares + lineage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createPlantShare', () => {
    it('writes a SHARE#{code} row with a frozen snapshot and a 14-day TTL', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb');
      const { createPlantShare } = await import('../../../src/services/plantService');

      // 1st send: getPlant (plant row read); 2nd: share Put.
      vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: plantRow });
      vi.mocked(dynamodb.send).mockResolvedValueOnce({});

      const before = Date.now();
      const share = await createPlantShare('hh-1', 'plant-1', 'user-1');
      const after = Date.now();

      expect(share).not.toBeNull();
      // 32 lowercase hex chars, like invite codes.
      expect(share!.code).toMatch(/^[0-9a-f]{32}$/);
      // Snapshot is the card as it stood at share time — name, species,
      // notes, imageUrl, tags. No location (room names are household-
      // internal) and no PII.
      expect(share!.plantSnapshot).toEqual({
        name: 'Mother Monstera',
        species: 'Monstera deliciosa',
        notes: 'east window',
        imageUrl: 'https://assets.example/plants/hh-1/plant-1/a.jpg',
        tags: ['tropical', 'gift'],
      });

      const put = vi.mocked(dynamodb.send).mock.calls[1][0] as unknown as {
        kind: string;
        input: { Item: Record<string, unknown> };
      };
      expect(put.kind).toBe('Put');
      expect(put.input.Item.PK).toBe(`SHARE#${share!.code}`);
      expect(put.input.Item.SK).toBe('METADATA');
      expect(put.input.Item.entityType).toBe('PlantShare');
      // ttl ≈ now + 14 days (epoch seconds), so DDB TTL sweeps it.
      const ttl = put.input.Item.ttl as number;
      const fourteenDays = 14 * 24 * 60 * 60;
      expect(ttl).toBeGreaterThanOrEqual(Math.floor(before / 1000) + fourteenDays);
      expect(ttl).toBeLessThanOrEqual(Math.ceil(after / 1000) + fourteenDays);
    });

    it('returns null when the plant is not in the household (no write)', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb');
      const { createPlantShare } = await import('../../../src/services/plantService');

      vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: undefined });

      const share = await createPlantShare('hh-1', 'nope', 'user-1');
      expect(share).toBeNull();
      expect(dynamodb.send).toHaveBeenCalledTimes(1); // read only, no Put
    });
  });

  describe('getPlantShare', () => {
    const storedShare = {
      code: 'c0ffee'.padEnd(32, '0'),
      plantId: 'plant-1',
      householdId: 'hh-1',
      plantSnapshot: {
        name: 'Mother Monstera',
        species: null,
        notes: null,
        imageUrl: null,
        tags: [],
      },
      createdBy: 'user-1',
      createdAt: '2026-06-01T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
    };

    it('returns the share for a live code', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb');
      const { getPlantShare } = await import('../../../src/services/plantService');
      vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: storedShare });
      const share = await getPlantShare(storedShare.code);
      expect(share).toMatchObject({ code: storedShare.code, plantId: 'plant-1' });
    });

    it('returns null for unknown codes', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb');
      const { getPlantShare } = await import('../../../src/services/plantService');
      vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: undefined });
      expect(await getPlantShare('f'.repeat(32))).toBeNull();
    });

    it('returns null for an expired row that DDB TTL has not swept yet', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb');
      const { getPlantShare } = await import('../../../src/services/plantService');
      vi.mocked(dynamodb.send).mockResolvedValueOnce({
        Item: { ...storedShare, expiresAt: '2020-01-01T00:00:00.000Z' },
      });
      expect(await getPlantShare(storedShare.code)).toBeNull();
    });
  });

  describe('getLineage', () => {
    const household = [
      { ...plantRow, id: 'parent-1', name: 'Mother', parentPlantId: null },
      {
        ...plantRow,
        id: 'kid-died',
        name: 'First Cutting',
        status: 'died',
        parentPlantId: 'parent-1',
        createdAt: '2026-02-01T00:00:00.000Z',
      },
      {
        ...plantRow,
        id: 'kid-alive',
        name: 'Second Cutting',
        status: 'active',
        parentPlantId: 'parent-1',
        createdAt: '2026-03-01T00:00:00.000Z',
      },
      { ...plantRow, id: 'unrelated', name: 'Cactus', parentPlantId: null },
    ];

    it('returns children (including died ones) oldest-first, no parent for a root plant', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb');
      const { getLineage } = await import('../../../src/services/plantService');
      vi.mocked(dynamodb.send).mockResolvedValueOnce({ Items: household });

      const lineage = await getLineage('hh-1', 'parent-1', null);
      expect(lineage.parent).toBeUndefined();
      // Died children are shown — propagation history is the point.
      expect(lineage.children).toEqual([
        {
          id: 'kid-died',
          name: 'First Cutting',
          status: 'died',
          createdAt: '2026-02-01T00:00:00.000Z',
        },
        {
          id: 'kid-alive',
          name: 'Second Cutting',
          status: 'active',
          createdAt: '2026-03-01T00:00:00.000Z',
        },
      ]);
    });

    it('resolves the parent entry for a cutting', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb');
      const { getLineage } = await import('../../../src/services/plantService');
      vi.mocked(dynamodb.send).mockResolvedValueOnce({ Items: household });

      const lineage = await getLineage('hh-1', 'kid-alive', 'parent-1');
      expect(lineage.parent).toEqual({ id: 'parent-1', name: 'Mother', status: 'active' });
      expect(lineage.children).toEqual([]);
    });

    it('omits the parent when it was hard-deleted (dangling link is history, not an error)', async () => {
      const { dynamodb } = await import('../../../src/utils/dynamodb');
      const { getLineage } = await import('../../../src/services/plantService');
      vi.mocked(dynamodb.send).mockResolvedValueOnce({
        Items: household.filter((p) => p.id !== 'parent-1'),
      });

      const lineage = await getLineage('hh-1', 'kid-alive', 'parent-1');
      expect(lineage.parent).toBeUndefined();
    });
  });
});
