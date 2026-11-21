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

/** A versioned bucket that enforces `If-Match` and `If-None-Match`, as production's does. */
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
        if (name === 'HeadObjectCommand') {
          const object = bucket.current.get(key);
          if (!object) {
            throw Object.assign(new Error('NotFound'), {
              name: 'NotFound',
              $metadata: { httpStatusCode: 404 },
            });
          }
          return { ContentLength: object.body.length, ContentType: object.contentType };
        }
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
          if (
            (input.IfMatch !== undefined && existing?.etag !== input.IfMatch) ||
            (input.IfNoneMatch === '*' && existing !== undefined)
          ) {
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

const { acceptUploadedPhoto, cleanPhoto, discardAcceptedPhoto, readUploadRequest } =
  await import('../../../src/services/photoIntake.js');

const HH = 'hh-1';
const PLANT = 'p-1';
/** The holding key a client uploads to, and the reference the presign returned for it. */
const UPLOAD_KEY = 'uploads/hh-1/p-1/0b7c0a4e-1111-4222-8333-944455556666.jpg';
const UPLOAD_URL = `https://images-bucket.s3.amazonaws.com/${UPLOAD_KEY}`;
const STORED_PREFIX = 'plants/hh-1/p-1/';

const storedKeys = () => [...bucket.current.keys()].filter((k) => k.startsWith(STORED_PREFIX));
const uploadKeys = () => [...bucket.current.keys()].filter((k) => k.startsWith('uploads/'));

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

describe('readUploadRequest: an upload URL is only signed for a declared size', () => {
  it('takes the declared type and size, and defaults the type to JPEG', () => {
    expect(readUploadRequest({ contentType: 'image/png', contentLength: 1234 })).toEqual({
      ok: true,
      contentType: 'image/png',
      contentLength: 1234,
    });
    expect(readUploadRequest({ contentLength: 9 })).toMatchObject({
      ok: true,
      contentType: 'image/jpeg',
    });
  });

  it('refuses a request with no size, in words a person can act on', () => {
    for (const body of [null, undefined, {}, { contentType: 'image/png' }]) {
      const result = readUploadRequest(body);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toMatch(/reload the page or update the app/i);
    }
  });

  it('accepts exactly 5 MiB and refuses one byte more', () => {
    expect(readUploadRequest({ contentLength: 5 * 1024 * 1024 }).ok).toBe(true);
    expect(readUploadRequest({ contentLength: 5 * 1024 * 1024 + 1 })).toEqual({
      ok: false,
      message: 'Image exceeds the 5 MiB limit',
    });
  });
});

describe('acceptUploadedPhoto — the confirm step, against a versioned bucket', () => {
  it('stores a GPS-bearing upload under a new plants/ key, without its location', async () => {
    bucket.put(UPLOAD_KEY, phoneJpeg(), 'image/jpeg');

    const result = await acceptUploadedPhoto(HH, PLANT, UPLOAD_URL);
    expect(result).toMatchObject({ ok: true, changed: true });
    if (!result.ok) return;
    // A key of the server's own: under the plant, and not the one uploaded to.
    expect(result.key).toMatch(/^plants\/hh-1\/p-1\/[0-9a-f-]{36}\.jpg$/);
    expect(result.key).not.toContain('0b7c0a4e-1111-4222-8333-944455556666');
    expect(result.imageUrl).toBe(`https://images-bucket.s3.amazonaws.com/${result.key}`);
    expect(storedKeys()).toEqual([result.key]);

    const stored = bucket.current.get(result.key)!;
    expectNoLocation(stored.body);
    expect(inspectPhotoMetadata(stored.body).orientation).toBe(6);
    // Written only if the key does not exist yet, as a private, typed object.
    const put = bucket.sends.find((s) => s.name === 'PutObjectCommand')!;
    expect(put.input).toMatchObject({
      Key: result.key,
      IfNoneMatch: '*',
      ContentType: 'image/jpeg',
      ContentLength: stored.body.length,
      CacheControl: 'private, max-age=3600',
    });
    // The upload is gone, every version of it, so no version of any key holds GPS.
    expect(uploadKeys()).toEqual([]);
    expect(bucket.versions.filter((v) => v.key === UPLOAD_KEY)).toEqual([]);
    for (const version of bucket.versions) expectNoLocation(version.body);
  });

  it('copies an already-clean photo too: what is stored is never the object uploaded to', async () => {
    bucket.put(UPLOAD_KEY, TINY_JPEG, 'image/jpeg');
    const result = await acceptUploadedPhoto(HH, PLANT, UPLOAD_URL);
    expect(result).toMatchObject({ ok: true, changed: false });
    if (!result.ok) return;
    expect(Buffer.from(bucket.current.get(result.key)!.body).equals(TINY_JPEG)).toBe(true);
    expect(bucket.current.has(UPLOAD_KEY)).toBe(false);
  });

  it('a later write to the upload key does not change the stored photo', async () => {
    bucket.put(UPLOAD_KEY, phoneJpeg(), 'image/jpeg');
    const first = await acceptUploadedPhoto(HH, PLANT, UPLOAD_URL);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const storedBefore = Buffer.from(bucket.current.get(first.key)!.body);

    // The upload URL is still within its lifetime, and something else arrives.
    bucket.put(UPLOAD_KEY, Buffer.from('<html>not a photo</html>'), 'image/jpeg');

    expect(Buffer.from(bucket.current.get(first.key)!.body).equals(storedBefore)).toBe(true);
    expect(storedKeys()).toEqual([first.key]);
    // Confirming it is a new check of the new bytes, which fail it.
    const second = await acceptUploadedPhoto(HH, PLANT, UPLOAD_URL);
    expect(second).toEqual({
      ok: false,
      status: 400,
      message: 'Uploaded file is not a valid image',
    });
    expect(storedKeys()).toEqual([first.key]);
    expect(uploadKeys()).toEqual([]);
  });

  it('refuses a HEIC with GPS, and deletes it: nothing is left to attach or to read', async () => {
    bucket.put(UPLOAD_KEY, iphoneHeicWithGps(), 'image/jpeg');
    const result = await acceptUploadedPhoto(HH, PLANT, UPLOAD_URL);
    expect(result).toEqual({
      ok: false,
      status: 400,
      message: 'Uploaded file is not a valid image',
    });
    expect(bucket.current.size).toBe(0);
    expect(bucket.versions).toEqual([]);
    expect(bucket.sends.some((s) => s.name === 'PutObjectCommand')).toBe(false);
  });

  it('refuses a reference to a stored photo: only an upload can be confirmed', async () => {
    const storedKey = `${STORED_PREFIX}11111111-2222-4333-8444-555555555555.jpg`;
    bucket.put(storedKey, TINY_JPEG, 'image/jpeg');
    const result = await acceptUploadedPhoto(
      HH,
      PLANT,
      `https://images-bucket.s3.amazonaws.com/${storedKey}`
    );
    expect(result).toEqual({
      ok: false,
      status: 400,
      message: 'imageUrl does not match a key issued for this plant',
    });
    expect(bucket.sends).toEqual([]);
    expect(bucket.current.has(storedKey)).toBe(true);
  });

  it("refuses another plant's upload and another household's", async () => {
    for (const key of ['uploads/hh-1/p-2/a.jpg', 'uploads/hh-2/p-1/a.jpg']) {
      bucket.put(key, TINY_JPEG, 'image/jpeg');
      const result = await acceptUploadedPhoto(
        HH,
        PLANT,
        `https://images-bucket.s3.amazonaws.com/${key}`
      );
      expect(result).toMatchObject({ ok: false, status: 400 });
    }
    expect(bucket.sends).toEqual([]);
  });

  it('refuses when nothing was uploaded', async () => {
    await expect(acceptUploadedPhoto(HH, PLANT, UPLOAD_URL)).resolves.toEqual({
      ok: false,
      status: 400,
      message: 'Uploaded image not found; upload it before confirming',
    });
    expect(bucket.sends.map((s) => s.name)).toEqual(['HeadObjectCommand']);
  });

  it('refuses and removes an upload over the size cap, without reading it', async () => {
    bucket.put(UPLOAD_KEY, new Uint8Array(5 * 1024 * 1024 + 1), 'image/jpeg');
    await expect(acceptUploadedPhoto(HH, PLANT, UPLOAD_URL)).resolves.toEqual({
      ok: false,
      status: 400,
      message: 'Image exceeds the 5 MiB limit',
    });
    expect(bucket.current.size).toBe(0);
    expect(bucket.sends.map((s) => s.name)).toEqual(['HeadObjectCommand', 'DeleteObjectCommand']);
  });

  it('refuses and removes an empty upload', async () => {
    bucket.put(UPLOAD_KEY, new Uint8Array(0), 'image/jpeg');
    await expect(acceptUploadedPhoto(HH, PLANT, UPLOAD_URL)).resolves.toEqual({
      ok: false,
      status: 400,
      message: 'Uploaded image is empty',
    });
    expect(bucket.current.size).toBe(0);
  });

  it('refuses and removes an upload stored with a type that is not an allowed image', async () => {
    bucket.put(UPLOAD_KEY, TINY_JPEG, 'text/html');
    await expect(acceptUploadedPhoto(HH, PLANT, UPLOAD_URL)).resolves.toEqual({
      ok: false,
      status: 400,
      message: 'Uploaded file is not a valid image',
    });
    expect(bucket.current.size).toBe(0);
    expect(bucket.sends.some((s) => s.name === 'GetObjectCommand')).toBe(false);
  });

  it('a storage failure that is not "missing" is an error, not a refusal', async () => {
    bucket.put(UPLOAD_KEY, TINY_JPEG, 'image/jpeg');
    const { s3 } = await import('../../../src/utils/s3.js');
    vi.mocked(s3.send).mockImplementationOnce(async () => {
      throw Object.assign(new Error('SlowDown'), { name: 'SlowDown' });
    });
    await expect(acceptUploadedPhoto(HH, PLANT, UPLOAD_URL)).rejects.toThrow('SlowDown');
    expect(bucket.current.has(UPLOAD_KEY)).toBe(true);
  });

  it('discardAcceptedPhoto removes a stored photo whose row was never written', async () => {
    bucket.put(UPLOAD_KEY, TINY_JPEG, 'image/jpeg');
    const result = await acceptUploadedPhoto(HH, PLANT, UPLOAD_URL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await discardAcceptedPhoto(result.key);
    expect(bucket.current.size).toBe(0);
  });
});
