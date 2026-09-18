/**
 * The stored-photo backfill (services/storedPhotoMetadataBackfill.ts) against
 * an in-memory VERSIONED bucket that evaluates the conditions the backfill
 * actually sends (`If-Match`, `VersionId`), the way production's does.
 *
 * What matters is not "the object was rewritten". It is:
 *   - a dry run writes nothing;
 *   - after `apply`, the bytes served under the same key carry no location,
 *     and everything else about the object is unchanged;
 *   - a photo deleted or replaced mid-run is never brought back or clobbered;
 *   - the original bytes survive as an old version unless deletion is asked
 *     for, and the report says so;
 *   - no key, coordinate or place name ever appears in the report.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import {
  runPhotoMetadataBackfill,
  type BackfillOptions,
} from '../../../src/services/storedPhotoMetadataBackfill.js';
import { carriesLocation, inspectPhotoMetadata } from '../../../src/services/photoMetadata.js';
import {
  TINY_JPEG,
  TINY_WEBP,
  canvasJpegFromSafari,
  contains,
  latitudeBytes,
  phoneJpeg,
} from './photoFixtures.js';

// ---------------------------------------------------------------------------
// In-memory versioned bucket
// ---------------------------------------------------------------------------

interface Version {
  versionId: string;
  bytes: Uint8Array | null; // null = delete marker
  etag: string;
  contentType?: string;
  cacheControl?: string;
  metadata?: Record<string, string>;
}

const BUCKET = 'images-test';
const HOUSEHOLD = 'hh-5f0c2a9e-1111-4c7b-9a3e-0d9b2c7e4f10';
const bucket = new Map<string, Version[]>(); // key -> versions, newest LAST
const sent: string[] = [];
let versionSeq = 0;
/** Runs just before a PUT is evaluated: a live request landing mid-run. */
let beforePut: ((key: string) => void) | null = null;

function httpError(name: string, status: number): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
}

function put(key: string, bytes: Uint8Array | null, extra: Partial<Version> = {}): Version {
  versionSeq += 1;
  const version: Version = {
    versionId: `v${versionSeq}`,
    bytes,
    etag: `"etag-${versionSeq}"`,
    ...extra,
  };
  bucket.set(key, [...(bucket.get(key) ?? []), version]);
  return version;
}

function current(key: string): Version | undefined {
  const versions = bucket.get(key) ?? [];
  return versions[versions.length - 1];
}

const PAGE = 2;

async function send(command: unknown): Promise<unknown> {
  if (command instanceof ListObjectVersionsCommand) {
    sent.push('List');
    const { Prefix = '', KeyMarker, VersionIdMarker } = command.input;
    const flat = [...bucket.keys()]
      .filter((key) => key.startsWith(Prefix))
      .sort()
      .flatMap((key) => {
        const versions = bucket.get(key)!;
        return versions
          .map((v, index) => ({ key, v, isLatest: index === versions.length - 1 }))
          .reverse();
      })
      .filter((row) => row.v.bytes !== null);
    let start = 0;
    if (KeyMarker) {
      start =
        flat.findIndex((row) => row.key === KeyMarker && row.v.versionId === VersionIdMarker) + 1;
    }
    const page = flat.slice(start, start + PAGE);
    const truncated = start + PAGE < flat.length;
    const last = page[page.length - 1];
    return {
      Versions: page.map((row) => ({
        Key: row.key,
        VersionId: row.v.versionId,
        IsLatest: row.isLatest,
      })),
      IsTruncated: truncated,
      NextKeyMarker: truncated ? last.key : undefined,
      NextVersionIdMarker: truncated ? last.v.versionId : undefined,
    };
  }
  if (command instanceof GetObjectCommand) {
    sent.push('Get');
    const { Key, VersionId } = command.input;
    const version = (bucket.get(Key!) ?? []).find((v) => v.versionId === VersionId);
    if (!version || version.bytes === null) throw httpError('NoSuchKey', 404);
    const bytes = version.bytes;
    return {
      Body: { transformToByteArray: async () => new Uint8Array(bytes) },
      ETag: version.etag,
      ContentType: version.contentType,
      CacheControl: version.cacheControl,
      Metadata: version.metadata ?? {},
    };
  }
  if (command instanceof PutObjectCommand) {
    sent.push('Put');
    const { Key, Body, IfMatch, ContentType, CacheControl, Metadata } = command.input;
    beforePut?.(Key!);
    // S3's rules: an unconditional PUT always lands, even over a delete
    // marker (that is how a deleted photo comes back). A conditional one needs
    // a live object whose ETag matches.
    if (IfMatch !== undefined) {
      const now = current(Key!);
      if (!now || now.bytes === null) throw httpError('NoSuchKey', 404);
      if (IfMatch !== now.etag) throw httpError('PreconditionFailed', 412);
    }
    put(Key!, new Uint8Array(Body as Uint8Array), {
      contentType: ContentType,
      cacheControl: CacheControl,
      metadata: Metadata,
    });
    return {};
  }
  if (command instanceof DeleteObjectCommand) {
    sent.push('Delete');
    const { Key, VersionId } = command.input;
    if (!VersionId) throw new Error('fake: the backfill must only ever delete a specific version');
    bucket.set(
      Key!,
      (bucket.get(Key!) ?? []).filter((v) => v.versionId !== VersionId)
    );
    return {};
  }
  throw new Error(`fake: unexpected command ${String(command)}`);
}

const s3 = { send } as unknown as S3Client;

const KEYS = {
  phone: `plants/${HOUSEHOLD}/plant-a/0a1b2c3d-phone.jpg`,
  canvas: `plants/${HOUSEHOLD}/plant-b/1b2c3d4e-canvas.jpg`,
  webp: `plants/${HOUSEHOLD}/plant-b/2c3d4e5f-clean.webp`,
  sitter: `plants/${HOUSEHOLD}/plant-c/3d4e5f60-sitter.jpg`,
  trashed: `trash/plants/${HOUSEHOLD}/plant-d/4e5f6071-trash.jpg`,
  broken: `plants/${HOUSEHOLD}/plant-e/5f607182-broken.jpg`,
};

function seed(): void {
  put(KEYS.phone, phoneJpeg(), { contentType: 'image/jpeg' });
  put(KEYS.canvas, canvasJpegFromSafari(), { contentType: 'image/jpeg' });
  put(KEYS.webp, TINY_WEBP, { contentType: 'image/webp' });
  put(KEYS.sitter, phoneJpeg(), {
    contentType: 'image/jpeg',
    cacheControl: 'public, max-age=31536000, immutable',
    metadata: { 'via-sitter': 'true', 'sitter-link-id': 'link-1' },
  });
  put(KEYS.trashed, phoneJpeg(), { contentType: 'image/jpeg' });
}

const DRY: BackfillOptions = { apply: false, deleteOldVersions: false, allMetadata: false };
const APPLY: BackfillOptions = { apply: true, deleteOldVersions: false, allMetadata: false };

function servedBytes(key: string): Uint8Array {
  return current(key)!.bytes!;
}

beforeEach(() => {
  bucket.clear();
  sent.length = 0;
  versionSeq = 0;
  beforePut = null;
});

describe('dry run', () => {
  it('reads everything, writes nothing, and counts what it found', async () => {
    seed();
    const before = JSON.stringify([...bucket.entries()].map(([k, v]) => [k, v.map((x) => x.etag)]));

    const report = await runPhotoMetadataBackfill(s3, BUCKET, DRY);

    expect(sent.filter((c) => c === 'Put' || c === 'Delete')).toEqual([]);
    expect(JSON.stringify([...bucket.entries()].map(([k, v]) => [k, v.map((x) => x.etag)]))).toBe(
      before
    );
    expect(report).toMatchObject({
      currentScanned: 5,
      noncurrentScanned: 0,
      currentWithLocation: 3, // phone, sitter, trashed
      currentWithAnyMetadata: 4, // + the canvas JPEG's harmless EXIF
      wouldStrip: 3,
      stripped: 0,
      oldVersionsRemaining: 3,
      cdnInvalidationNeeded: false,
    });
  });

  it('pages through the whole listing', async () => {
    seed(); // 5 versions at 2 per page
    const report = await runPhotoMetadataBackfill(s3, BUCKET, DRY);
    expect(sent.filter((c) => c === 'List').length).toBeGreaterThanOrEqual(3);
    expect(report.currentScanned).toBe(5);
  });
});

describe('apply', () => {
  it('rewrites each photo that carries location, in place, and nothing else', async () => {
    seed();
    const report = await runPhotoMetadataBackfill(s3, BUCKET, APPLY);

    expect(report).toMatchObject({
      stripped: 3,
      raced: 0,
      skipped: 0,
      cdnInvalidationNeeded: true,
    });
    for (const key of [KEYS.phone, KEYS.sitter, KEYS.trashed]) {
      expect(carriesLocation(inspectPhotoMetadata(servedBytes(key)))).toBe(false);
      expect(contains(servedBytes(key), latitudeBytes())).toBe(false);
    }
    // Photos with no location were not touched: still one version each.
    expect(bucket.get(KEYS.canvas)).toHaveLength(1);
    expect(bucket.get(KEYS.webp)).toHaveLength(1);
  });

  it('keeps Content-Type, Cache-Control and the sitter attribution on the rewrite', async () => {
    seed();
    await runPhotoMetadataBackfill(s3, BUCKET, APPLY);
    expect(current(KEYS.sitter)).toMatchObject({
      contentType: 'image/jpeg',
      cacheControl: 'public, max-age=31536000, immutable',
      metadata: { 'via-sitter': 'true', 'sitter-link-id': 'link-1' },
    });
  });

  it('leaves the original as an old version, and says so', async () => {
    seed();
    const report = await runPhotoMetadataBackfill(s3, BUCKET, APPLY);
    const versions = bucket.get(KEYS.phone)!;
    expect(versions).toHaveLength(2);
    expect(contains(versions[0].bytes!, latitudeBytes())).toBe(true);
    expect(report.oldVersionsRemaining).toBe(3);

    // A second run sees those old versions, and keeps them unless told.
    const again = await runPhotoMetadataBackfill(s3, BUCKET, APPLY);
    expect(again).toMatchObject({
      stripped: 0,
      noncurrentWithLocation: 3,
      oldVersionsRemaining: 3,
    });
  });

  it('with deleteOldVersions, removes the originals once their replacements are written', async () => {
    seed();
    // A photo overwritten long ago whose OLD version still holds GPS.
    put(KEYS.webp, TINY_WEBP, { contentType: 'image/webp' });
    bucket.set(KEYS.webp, [
      { ...bucket.get(KEYS.webp)![0], bytes: phoneJpeg() },
      bucket.get(KEYS.webp)![1],
    ]);

    const report = await runPhotoMetadataBackfill(s3, BUCKET, {
      ...APPLY,
      deleteOldVersions: true,
    });

    expect(report).toMatchObject({ stripped: 3, oldVersionsDeleted: 4, oldVersionsRemaining: 0 });
    for (const [key, versions] of bucket) {
      for (const version of versions) {
        expect(contains(version.bytes!, latitudeBytes()), key).toBe(false);
      }
    }
    // The clean current WebP is still there.
    expect(Buffer.from(servedBytes(KEYS.webp)).equals(TINY_WEBP)).toBe(true);
  });

  it('never clobbers a photo a live request replaced mid-run', async () => {
    seed();
    beforePut = (key) => {
      if (key === KEYS.phone) put(KEYS.phone, TINY_JPEG, { contentType: 'image/jpeg' });
    };
    const report = await runPhotoMetadataBackfill(s3, BUCKET, APPLY);
    expect(report.raced).toBe(1);
    expect(Buffer.from(servedBytes(KEYS.phone)).equals(TINY_JPEG)).toBe(true);
  });

  it('never brings back a photo deleted mid-run', async () => {
    seed();
    beforePut = (key) => {
      if (key === KEYS.phone) put(KEYS.phone, null); // delete marker
    };
    const report = await runPhotoMetadataBackfill(s3, BUCKET, APPLY);
    expect(report.raced).toBe(1);
    expect(current(KEYS.phone)!.bytes).toBeNull();
  });

  it('skips what it cannot parse and never writes it', async () => {
    seed();
    put(KEYS.broken, new Uint8Array(Buffer.from('<html>not a photo</html>')), {
      contentType: 'image/jpeg',
    });
    const report = await runPhotoMetadataBackfill(s3, BUCKET, APPLY);
    expect(report.skipped).toBe(1);
    expect(bucket.get(KEYS.broken)).toHaveLength(1);
  });

  it('with allMetadata, also rewrites the harmless canvas EXIF, and a re-run is a no-op', async () => {
    seed();
    const report = await runPhotoMetadataBackfill(s3, BUCKET, { ...APPLY, allMetadata: true });
    expect(report.stripped).toBe(4);
    expect(bucket.get(KEYS.canvas)).toHaveLength(2);

    const again = await runPhotoMetadataBackfill(s3, BUCKET, { ...APPLY, allMetadata: true });
    expect(again.stripped).toBe(0);
  });
});

describe('what the report may say', () => {
  it('never carries a key, a household id or a coordinate', async () => {
    seed();
    const text = JSON.stringify(await runPhotoMetadataBackfill(s3, BUCKET, APPLY));
    expect(text).not.toContain(HOUSEHOLD);
    for (const key of Object.values(KEYS)) expect(text).not.toContain(key);
    expect(text).not.toContain('Springfield');
    expect(text).not.toContain('PhoneCo');
    expect(text).not.toMatch(/\b3012\b|\b1188\b/);
    // It does name each finding by a short ref an operator can match up.
    expect(text).toContain('"ref":"0a1b2c3d"');
  });
});
