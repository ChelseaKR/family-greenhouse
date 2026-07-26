import { describe, expect, it, vi } from 'vitest';
import {
  buildSmokeEmail,
  householdIdFromCreateResponse,
  householdIdFromMembershipItem,
  isAmazonS3Hostname,
  purgeExactSmokeS3Object,
  purgeSmokeOwnedPartitions,
  runAllCleanupSteps,
  s3ObjectTargetFromPresignedUrl,
  safeResponseDiagnostic,
} from '../../e2e/post-deploy-smoke-support';

describe('post-deploy smoke support', () => {
  describe('buildSmokeEmail', () => {
    it('builds a unique address from a configured deliverable template', () => {
      expect(buildSmokeEmail('fg-smoke+{tag}@example.com', 'public-a1b2')).toBe(
        'fg-smoke+public-a1b2@example.com'
      );
    });

    it.each([
      [undefined, /is required/i],
      ['fg-smoke@example.com', /exactly one \{tag\}/i],
      ['fg-{tag}-{tag}@example.com', /exactly one \{tag\}/i],
      ['fg@example.{tag}', /before @/i],
    ])('rejects an unsafe template: %s', (template, message) => {
      expect(() => buildSmokeEmail(template, 'public-a1b2')).toThrow(message);
    });
  });

  describe('householdIdFromMembershipItem', () => {
    it('reads and validates the household id from GSI1SK', () => {
      expect(
        householdIdFromMembershipItem({
          SK: { S: 'MEMBER#cognito-sub' },
          GSI1SK: { S: 'HOUSEHOLD#550e8400-e29b-41d4-a716-446655440000' },
        })
      ).toBe('550e8400-e29b-41d4-a716-446655440000');
    });

    it.each([
      [{ SK: { S: 'HOUSEHOLD#550e8400-e29b-41d4-a716-446655440000' } }],
      [{ GSI1SK: { S: 'HOUSEHOLD#not-a-uuid' } }],
      [{ GSI1SK: { S: 'MEMBER#550e8400-e29b-41d4-a716-446655440000' } }],
    ])('rejects a membership item without a valid GSI1SK: %j', (item) => {
      expect(householdIdFromMembershipItem(item)).toBeNull();
    });
  });

  describe('householdIdFromCreateResponse', () => {
    it('captures the authoritative household id from the create response', () => {
      expect(householdIdFromCreateResponse({ id: '550e8400-e29b-41d4-a716-446655440000' })).toBe(
        '550e8400-e29b-41d4-a716-446655440000'
      );
    });

    it.each([undefined, {}, { id: 'not-a-uuid' }])(
      'rejects a malformed household create response: %j',
      (response) => {
        expect(() => householdIdFromCreateResponse(response)).toThrow(/valid household UUID/i);
      }
    );
  });

  describe('safe deployed-network diagnostics', () => {
    it('keeps only hostname and status from a presigned URL', () => {
      const diagnostic = safeResponseDiagnostic(
        'https://photos.s3.us-east-1.amazonaws.com/plants/photo.webp?X-Amz-Credential=secret&X-Amz-Signature=do-not-log',
        403
      );

      expect(diagnostic).toEqual({
        hostname: 'photos.s3.us-east-1.amazonaws.com',
        status: 403,
      });
      expect(JSON.stringify(diagnostic)).not.toMatch(
        /plants|credential|signature|secret|do-not-log/i
      );
    });

    it('does not echo malformed URLs and recognizes only Amazon S3 hosts', () => {
      expect(safeResponseDiagnostic('not-a-url?token=do-not-log', 0)).toEqual({
        hostname: '<invalid-url>',
        status: 0,
      });
      expect(isAmazonS3Hostname('family-greenhouse.s3.us-east-1.amazonaws.com')).toBe(true);
      expect(isAmazonS3Hostname('s3.amazonaws.com')).toBe(true);
      expect(isAmazonS3Hostname('s3.amazonaws.com.example.test')).toBe(false);
      expect(isAmazonS3Hostname('bucket.s3-control.us-east-1.amazonaws.com')).toBe(false);
      expect(isAmazonS3Hostname(`bucket.s3-${'--'.repeat(10_000)}.amazonaws.com`)).toBe(false);
    });
  });

  describe('exact deployed S3 cleanup', () => {
    it('extracts a virtual-hosted S3 bucket/key without retaining presign credentials', () => {
      const target = s3ObjectTargetFromPresignedUrl(
        'https://family-greenhouse-images-production-12345678.s3.us-east-1.amazonaws.com/plants/household/plant/photo.webp?X-Amz-Credential=secret&X-Amz-Signature=do-not-log'
      );

      expect(target).toEqual({
        bucket: 'family-greenhouse-images-production-12345678',
        key: 'plants/household/plant/photo.webp',
      });
      expect(JSON.stringify(target)).not.toMatch(/credential|signature|secret|do-not-log/i);
    });

    it('extracts and decodes a path-style S3 bucket/key', () => {
      expect(
        s3ObjectTargetFromPresignedUrl(
          'https://s3.us-east-1.amazonaws.com/family-greenhouse-images-production-12345678/plants/household/plant/photo%20one.png?X-Amz-Signature=secret'
        )
      ).toEqual({
        bucket: 'family-greenhouse-images-production-12345678',
        key: 'plants/household/plant/photo one.png',
      });
    });

    it('rejects non-S3 and malformed targets without echoing their query strings', () => {
      for (const rawUrl of [
        'https://s3.amazonaws.com.example.test/bucket/key?X-Amz-Signature=do-not-log',
        'https://bucket.s3-object-lambda.us-east-1.amazonaws.com/key?X-Amz-Signature=do-not-log',
        'not-a-url?X-Amz-Signature=do-not-log',
      ]) {
        try {
          s3ObjectTargetFromPresignedUrl(rawUrl);
          throw new Error('expected target parsing to fail');
        } catch (error) {
          expect((error as Error).message).not.toMatch(/signature|do-not-log/i);
        }
      }
    });

    it('paginates Versions and DeleteMarkers, deletes only the exact key, and verifies empty', async () => {
      const target = {
        bucket: 'family-greenhouse-images-production-12345678',
        key: 'plants/household/plant/photo.webp',
      };
      const listVersions = vi
        .fn()
        .mockResolvedValueOnce({
          versions: [
            { key: target.key, versionId: 'version-3' },
            { key: `${target.key}.unrelated`, versionId: 'leave-me' },
          ],
          deleteMarkers: [{ key: target.key, versionId: 'delete-marker-2' }],
          isTruncated: true,
          nextKeyMarker: target.key,
          nextVersionIdMarker: 'delete-marker-2',
        })
        .mockResolvedValueOnce({
          versions: [{ key: target.key, versionId: 'version-1' }],
          deleteMarkers: [{ key: target.key, versionId: 'delete-marker-1' }],
          isTruncated: false,
        })
        .mockResolvedValueOnce({
          versions: [{ key: `${target.key}.unrelated`, versionId: 'leave-me' }],
          isTruncated: false,
        });
      const deleteVersions = vi.fn(async () => undefined);

      await purgeExactSmokeS3Object(target, { listVersions, deleteVersions });

      expect(listVersions).toHaveBeenNthCalledWith(2, {
        bucket: target.bucket,
        prefix: target.key,
        keyMarker: target.key,
        versionIdMarker: 'delete-marker-2',
      });
      expect(deleteVersions).toHaveBeenCalledOnce();
      expect(deleteVersions).toHaveBeenCalledWith({
        bucket: target.bucket,
        objects: [
          { key: target.key, versionId: 'version-3' },
          { key: target.key, versionId: 'delete-marker-2' },
          { key: target.key, versionId: 'version-1' },
          { key: target.key, versionId: 'delete-marker-1' },
        ],
      });
    });

    it('is a true no-op when the flow failed before presign', async () => {
      const listVersions = vi.fn();
      const deleteVersions = vi.fn();

      await purgeExactSmokeS3Object(undefined, { listVersions, deleteVersions });

      expect(listVersions).not.toHaveBeenCalled();
      expect(deleteVersions).not.toHaveBeenCalled();
    });

    it('fails when the exact object still has version residue after deletion', async () => {
      const target = {
        bucket: 'family-greenhouse-images-production-12345678',
        key: 'plants/household/plant/photo.webp',
      };
      const residue = {
        versions: [{ key: target.key, versionId: 'version-1' }],
        isTruncated: false,
      };

      await expect(
        purgeExactSmokeS3Object(target, {
          listVersions: vi.fn().mockResolvedValue(residue),
          deleteVersions: vi.fn(async () => undefined),
        })
      ).rejects.toThrow(/1 exact S3 version record.*remained/i);
    });
  });

  it('attempts every cleanup step before reporting all failures', async () => {
    const attempted: string[] = [];
    const successful = vi.fn(async () => {
      attempted.push('cognito');
    });

    await expect(
      runAllCleanupSteps([
        {
          label: 'DynamoDB lookup',
          run: async () => {
            attempted.push('lookup');
            throw new Error('lookup failed');
          },
        },
        {
          label: 'DynamoDB delete',
          run: async () => {
            attempted.push('delete');
            throw new Error('delete failed');
          },
        },
        { label: 'Cognito delete', run: successful },
      ])
    ).rejects.toThrow(/DynamoDB lookup: lookup failed.*DynamoDB delete: delete failed/i);

    expect(attempted).toEqual(['lookup', 'delete', 'cognito']);
    expect(successful).toHaveBeenCalledOnce();
  });

  it('runs the final exact-S3 fallback even when account and admin cleanup both fail', async () => {
    const exactS3Fallback = vi.fn(async () => undefined);

    await expect(
      runAllCleanupSteps([
        {
          label: 'DELETE /me account cleanup',
          run: async () => {
            throw new Error('api cleanup failed');
          },
        },
        {
          label: 'Administrative smoke fixture fallback',
          run: async () => {
            throw new Error('admin cleanup failed');
          },
        },
        { label: 'Exact S3 upload fallback', run: exactS3Fallback },
      ])
    ).rejects.toThrow(/api cleanup failed.*admin cleanup failed/i);

    expect(exactS3Fallback).toHaveBeenCalledOnce();
  });

  it('purges every smoke-owned partition row, including the welcome marker, and verifies teardown', async () => {
    const rows = new Map([
      [
        'USER#user-1',
        [
          { PK: 'USER#user-1', SK: 'PREFS' },
          { PK: 'USER#user-1', SK: 'WELCOME#FIRST_HOUSEHOLD' },
        ],
      ],
      [
        'HOUSEHOLD#household-1',
        [
          { PK: 'HOUSEHOLD#household-1', SK: 'METADATA' },
          { PK: 'HOUSEHOLD#household-1', SK: 'MEMBER#user-1' },
        ],
      ],
    ]);
    const deleted: Array<{ PK: string; SK: string }> = [];
    const listKeys = vi.fn(async (partitionKey: string) => [...(rows.get(partitionKey) ?? [])]);
    const deleteKeys = vi.fn(async (keys: Array<{ PK: string; SK: string }>) => {
      deleted.push(...keys);
      for (const key of keys) {
        rows.set(
          key.PK,
          (rows.get(key.PK) ?? []).filter(
            (candidate) => candidate.PK !== key.PK || candidate.SK !== key.SK
          )
        );
      }
    });

    await purgeSmokeOwnedPartitions(['USER#user-1', 'HOUSEHOLD#household-1', 'USER#user-1'], {
      listKeys,
      deleteKeys,
    });

    expect(deleted).toContainEqual({
      PK: 'USER#user-1',
      SK: 'WELCOME#FIRST_HOUSEHOLD',
    });
    expect(rows.get('USER#user-1')).toEqual([]);
    expect(rows.get('HOUSEHOLD#household-1')).toEqual([]);
    expect(listKeys).toHaveBeenCalledTimes(4);
    expect(deleteKeys).toHaveBeenCalledTimes(2);
  });

  it('fails cleanup when a partition is not empty after deletion', async () => {
    const marker = { PK: 'USER#user-1', SK: 'WELCOME#FIRST_HOUSEHOLD' };

    await expect(
      purgeSmokeOwnedPartitions(['USER#user-1'], {
        listKeys: async () => [marker],
        deleteKeys: async () => {
          // Simulate a falsely successful delete response.
        },
      })
    ).rejects.toThrow(/WELCOME#FIRST_HOUSEHOLD/i);
  });
});
