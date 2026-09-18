/**
 * The operator CLI for the stored-photo metadata backfill. The backfill itself
 * is tested in tests/unit/services/storedPhotoMetadataBackfill.test.ts. This
 * pins what an operator relies on: a dry run unless told otherwise, no
 * deletion without an explicit write, the CDN step spelled out, and an exit
 * status that doesn't read a partial run as a finished one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { S3Client } from '@aws-sdk/client-s3';

vi.mock('../../../src/services/storedPhotoMetadataBackfill.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/services/storedPhotoMetadataBackfill.js')>();
  return { ...actual, runPhotoMetadataBackfill: vi.fn() };
});

async function load() {
  const cli = await import('../../../src/scripts/stripStoredPhotoMetadata.js');
  const backfill = await import('../../../src/services/storedPhotoMetadataBackfill.js');
  return { cli, backfill };
}

type Report = import('../../../src/services/storedPhotoMetadataBackfill.js').BackfillReport;

function report(overrides: Partial<Report> = {}): Report {
  return {
    apply: false,
    deleteOldVersions: false,
    allMetadata: false,
    currentScanned: 5,
    noncurrentScanned: 0,
    currentWithLocation: 0,
    noncurrentWithLocation: 0,
    currentWithAnyMetadata: 4,
    wouldStrip: 0,
    stripped: 0,
    raced: 0,
    skipped: 0,
    oldVersionsDeleted: 0,
    oldVersionsRemaining: 0,
    cdnInvalidationNeeded: false,
    findings: [],
    ...overrides,
  };
}

const s3 = {} as S3Client;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('parseCliArgs', () => {
  it('is a dry run unless --confirm is passed', async () => {
    const { cli } = await load();
    expect(cli.parseCliArgs([], { IMAGES_BUCKET: 'b' })).toMatchObject({
      bucket: 'b',
      apply: false,
      deleteOldVersions: false,
      allMetadata: false,
      prefixes: ['plants/', 'trash/plants/'],
    });
    expect(cli.parseCliArgs(['--confirm'], { IMAGES_BUCKET: 'b' }).apply).toBe(true);
  });

  it('prefers --bucket over IMAGES_BUCKET, and needs one of them', async () => {
    const { cli } = await load();
    expect(cli.parseCliArgs(['--bucket', 'flag'], { IMAGES_BUCKET: 'env' }).bucket).toBe('flag');
    expect(() => cli.parseCliArgs([], {})).toThrow(/images bucket/);
  });

  it('refuses --delete-old-versions without --confirm', async () => {
    const { cli } = await load();
    expect(() => cli.parseCliArgs(['--delete-old-versions'], { IMAGES_BUCKET: 'b' })).toThrow(
      /only works with --confirm/
    );
    expect(
      cli.parseCliArgs(['--confirm', '--delete-old-versions'], { IMAGES_BUCKET: 'b' })
        .deleteOldVersions
    ).toBe(true);
  });

  it('rejects an unknown flag rather than ignoring it', async () => {
    const { cli } = await load();
    expect(() => cli.parseCliArgs(['--yes'], { IMAGES_BUCKET: 'b' })).toThrow();
  });
});

describe('formatReport', () => {
  it('says a dry run wrote nothing', async () => {
    const { cli } = await load();
    expect(cli.formatReport(report({ wouldStrip: 2 }))).toMatch(
      /Would rewrite without location metadata: 2/
    );
    expect(cli.formatReport(report())).toMatch(/Dry run only/);
  });

  it('spells out the CloudFront invalidation when a served photo changed', async () => {
    const { cli } = await load();
    const text = cli.formatReport(
      report({ apply: true, stripped: 1, cdnInvalidationNeeded: true })
    );
    expect(text).toContain('aws cloudfront create-invalidation');
    expect(text).toContain('"/plants/*"');
    expect(cli.formatReport(report({ apply: true }))).not.toContain('create-invalidation');
  });

  it('says how many old versions still hold the original bytes', async () => {
    const { cli } = await load();
    expect(cli.formatReport(report({ apply: true, stripped: 1, oldVersionsRemaining: 1 }))).toMatch(
      /Old versions still holding the original bytes: 1/
    );
  });
});

describe('main', () => {
  it('exits 1 on bad arguments without touching the bucket', async () => {
    const { cli, backfill } = await load();
    expect(await cli.main(['--delete-old-versions', '--bucket', 'b'], s3)).toBe(1);
    expect(backfill.runPhotoMetadataBackfill).not.toHaveBeenCalled();
  });

  it('exits 0 on a finished run', async () => {
    const { cli, backfill } = await load();
    vi.mocked(backfill.runPhotoMetadataBackfill).mockResolvedValue(report());
    expect(await cli.main(['--bucket', 'b'], s3)).toBe(0);
    expect(backfill.runPhotoMetadataBackfill).toHaveBeenCalledWith(
      s3,
      'b',
      expect.objectContaining({ apply: false, deleteOldVersions: false })
    );
  });

  it('exits 2 when anything raced or was skipped', async () => {
    const { cli, backfill } = await load();
    vi.mocked(backfill.runPhotoMetadataBackfill).mockResolvedValue(
      report({ apply: true, raced: 1 })
    );
    expect(await cli.main(['--bucket', 'b', '--confirm'], s3)).toBe(2);
    vi.mocked(backfill.runPhotoMetadataBackfill).mockResolvedValue(report({ skipped: 1 }));
    expect(await cli.main(['--bucket', 'b'], s3)).toBe(2);
  });
});
