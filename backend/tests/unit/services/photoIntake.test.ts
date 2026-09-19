/**
 * The server's own metadata strip for uploaded photos (services/photoIntake.ts).
 *
 * Every assertion that location is GONE is made by PARSING the bytes that
 * would be stored — with the same inspector the operator backfill trusts —
 * and by looking for the fixture's own coordinate bytes, never by trusting a
 * flag the code under test returned. And each fixture is first shown to carry
 * the location, so a test that finds none afterwards could have found some.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canvasJpegFromSafari,
  contains,
  jpegScan,
  latitudeBytes,
  phoneJpeg,
  pngWithLocation,
  TINY_JPEG,
  webpWithLocation,
} from './photoFixtures.js';
import { iphoneHeicWithGps } from './uploadFixtures.js';
import { carriesLocation, inspectPhotoMetadata } from '../../../src/services/photoMetadata.js';

interface StoredObject {
  body: Uint8Array;
  contentType: string;
  etag: string;
  versionId: string;
  cacheControl?: string;
  metadata?: Record<string, string>;
}

/** A versioned bucket that enforces `If-Match`, as production's does. */
const bucket = {
  current: new Map<string, StoredObject>(),
  versions: [] as Array<{ key: string } & StoredObject>,
  sends: [] as Array<{ name: string; input: Record<string, unknown> }>,
  serial: 0,
  reset() {
    this.current.clear();
    this.versions = [];
    this.sends = [];
    this.serial = 0;
  },
  put(key: string, body: Uint8Array, contentType: string, extra: Partial<StoredObject> = {}) {
    this.serial += 1;
    const object: StoredObject = {
      body,
      contentType,
      etag: `"etag-${this.serial}"`,
      versionId: `v${this.serial}`,
      ...extra,
    };
    this.current.set(key, object);
    this.versions.push({ key, ...object });
    return object;
  },
};

vi.mock('../../../src/utils/s3.js', () => ({
  IMAGES_BUCKET: 'images-bucket',
  s3: {
    send: vi.fn(
      async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        const name = command.constructor.name;
        const input = command.input;
        bucket.sends.push({ name, input });
        const key = input.Key as string;
        if (name === 'GetObjectCommand') {
          const object = bucket.current.get(key);
          if (!object) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
          return {
            Body: { transformToByteArray: async () => object.body },
            ContentType: object.contentType,
            ETag: object.etag,
            VersionId: object.versionId,
            CacheControl: object.cacheControl,
            Metadata: object.metadata,
          };
        }
        if (name === 'PutObjectCommand') {
          const existing = bucket.current.get(key);
          if (input.IfMatch !== undefined && existing?.etag !== input.IfMatch) {
            throw Object.assign(new Error('PreconditionFailed'), {
              name: 'PreconditionFailed',
              $metadata: { httpStatusCode: 412 },
            });
          }
          bucket.put(key, input.Body as Uint8Array, input.ContentType as string, {
            cacheControl: input.CacheControl as string | undefined,
            metadata: input.Metadata as Record<string, string> | undefined,
          });
          return {};
        }
        if (name === 'DeleteObjectCommand') {
          if (input.VersionId) {
            bucket.versions = bucket.versions.filter(
              (v) => !(v.key === key && v.versionId === input.VersionId)
            );
            if (bucket.current.get(key)?.versionId === input.VersionId) bucket.current.delete(key);
          } else {
            bucket.current.delete(key);
          }
          return {};
        }
        throw new Error(`unexpected ${name}`);
      }
    ),
  },
}));

const { cleanPhoto, sanitizeUploadedPhoto } = await import('../../../src/services/photoIntake.js');

const KEY = 'plants/hh-1/p-1/0b7c0a4e-1111-4222-8333-944455556666.jpg';

/** Nothing a map could use: parsed, and searched for the fixture's own coordinate bytes. */
function expectNoLocation(bytes: Uint8Array) {
  expect(carriesLocation(inspectPhotoMetadata(bytes))).toBe(false);
  expect(contains(bytes, latitudeBytes())).toBe(false);
  expect(Buffer.from(bytes).includes('PhoneCo')).toBe(false); // the camera make
  expect(Buffer.from(bytes).includes('Springfield')).toBe(false); // the IPTC city
}

beforeEach(() => bucket.reset());

describe('the fixtures carry what the tests say they do', () => {
  it('the phone JPEG, the PNG and the WebP each carry a location', () => {
    for (const bytes of [phoneJpeg(), pngWithLocation(), webpWithLocation()]) {
      expect(carriesLocation(inspectPhotoMetadata(bytes))).toBe(true);
      expect(contains(bytes, latitudeBytes())).toBe(true);
    }
  });

  it('the HEIC is a HEIC, and its Exif item carries the same GPS', () => {
    const heic = iphoneHeicWithGps();
    expect(Buffer.from(heic.subarray(4, 12)).toString('latin1')).toBe('ftypheic');
    expect(contains(heic, latitudeBytes())).toBe(true);
  });
});

describe('cleanPhoto', () => {
  it('removes everything from a phone JPEG but its orientation, and keeps its pixels', () => {
    const input = phoneJpeg();
    const result = cleanPhoto(input, 'image/jpeg');
    expect(result).toMatchObject({
      ok: true,
      format: 'image/jpeg',
      changed: true,
      hadLocation: true,
    });
    if (!result.ok) return;
    expectNoLocation(result.bytes);
    const report = inspectPhotoMetadata(result.bytes);
    expect(report).toMatchObject({ xmp: false, iptc: false, trailingImage: false, orientation: 6 });
    expect(Buffer.from(jpegScan(result.bytes)).equals(Buffer.from(jpegScan(input)))).toBe(true);
  });

  it('strips a PNG and a WebP the same way', () => {
    for (const [bytes, type] of [
      [pngWithLocation(), 'image/png'],
      [webpWithLocation(), 'image/webp'],
    ] as const) {
      const result = cleanPhoto(bytes, type);
      expect(result.ok, type).toBe(true);
      if (result.ok) expectNoLocation(result.bytes);
    }
  });

  it('refuses a HEIC, whatever type the upload claimed', () => {
    expect(cleanPhoto(iphoneHeicWithGps(), 'image/jpeg')).toEqual({
      ok: false,
      reason: 'not_an_image',
    });
    expect(cleanPhoto(iphoneHeicWithGps())).toEqual({ ok: false, reason: 'not_an_image' });
  });

  it('refuses bytes that are not the type the upload declared', () => {
    expect(cleanPhoto(phoneJpeg(), 'image/png')).toEqual({ ok: false, reason: 'type_mismatch' });
  });

  it('refuses a JPEG it cannot parse, rather than storing it as it came', () => {
    const header = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x40]),
      Buffer.alloc(8),
    ]);
    expect(cleanPhoto(header, 'image/jpeg')).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('leaves an already-clean photo byte for byte as it was', () => {
    const result = cleanPhoto(TINY_JPEG, 'image/jpeg');
    expect(result).toMatchObject({ ok: true, changed: false, hadLocation: false });
    if (result.ok) expect(Buffer.from(result.bytes).equals(TINY_JPEG)).toBe(true);
  });

  it('removes the metadata a canvas encoder writes, though it is not a location', () => {
    const result = cleanPhoto(canvasJpegFromSafari(), 'image/jpeg');
    expect(result).toMatchObject({ ok: true, changed: true, hadLocation: false });
  });
});

describe('sanitizeUploadedPhoto — the confirm step, against a versioned bucket', () => {
  it('rewrites a GPS-bearing upload in place, and the stored photo carries no location', async () => {
    bucket.put(KEY, phoneJpeg(), 'image/jpeg', {
      cacheControl: 'private, max-age=3600',
      metadata: { 'via-sitter': 'true' },
    });
    const original = bucket.current.get(KEY)!;

    await expect(sanitizeUploadedPhoto(KEY, 'image/jpeg')).resolves.toEqual({
      ok: true,
      changed: true,
    });
    const stored = bucket.current.get(KEY)!;
    expectNoLocation(stored.body);
    expect(inspectPhotoMetadata(stored.body).orientation).toBe(6);
    // Written conditionally on the object it read, keeping its attributes.
    const put = bucket.sends.find((s) => s.name === 'PutObjectCommand')!;
    expect(put.input).toMatchObject({
      IfMatch: original.etag,
      ContentType: 'image/jpeg',
      CacheControl: 'private, max-age=3600',
      Metadata: { 'via-sitter': 'true' },
    });
    // And the original's version is gone too: no version of the key holds GPS.
    expect(bucket.versions.filter((v) => v.key === KEY)).toHaveLength(1);
    for (const version of bucket.versions) expectNoLocation(version.body);
  });

  it('refuses a HEIC with GPS, and deletes it: nothing is left to attach or to read', async () => {
    bucket.put(KEY, iphoneHeicWithGps(), 'image/jpeg');
    const result = await sanitizeUploadedPhoto(KEY, 'image/jpeg');
    expect(result).toEqual({
      ok: false,
      status: 400,
      message: 'Uploaded file is not a valid image',
    });
    expect(bucket.current.has(KEY)).toBe(false);
    expect(bucket.versions.filter((v) => v.key === KEY)).toEqual([]);
    expect(bucket.sends.some((s) => s.name === 'PutObjectCommand')).toBe(false);
  });

  it('does not write a clean photo again', async () => {
    bucket.put(KEY, TINY_JPEG, 'image/jpeg');
    await expect(sanitizeUploadedPhoto(KEY, 'image/jpeg')).resolves.toEqual({
      ok: true,
      changed: false,
    });
    expect(bucket.sends.map((s) => s.name)).toEqual(['GetObjectCommand']);
  });

  it('refuses, rather than overwrites, an upload that changed while it was being checked', async () => {
    bucket.put(KEY, phoneJpeg(), 'image/jpeg');
    const { s3 } = await import('../../../src/utils/s3.js');
    const send = vi.mocked(s3.send);
    const realSend = send.getMockImplementation()!;
    // A second PUT lands between the read and the conditional write.
    send.mockImplementationOnce(async (command) => {
      const result = await realSend(command as never);
      bucket.put(KEY, pngWithLocation(), 'image/png');
      return result;
    });
    const result = await sanitizeUploadedPhoto(KEY, 'image/jpeg');
    expect(result).toMatchObject({ ok: false, status: 409 });
    for (const version of bucket.versions.filter(
      (v) => v.key === KEY && v.contentType === 'image/jpeg'
    )) {
      // The first upload was never rewritten with anything.
      expect(Buffer.from(version.body).equals(Buffer.from(phoneJpeg()))).toBe(true);
    }
  });
});
