/**
 * Plant photos are served only through short-lived signed URLs (ADR 0033).
 *
 * These tests sign with REAL SigV4 (fake credentials, no network) and check
 * every URL with `presignedGetOrigin`, a verifier written from the SigV4
 * specification rather than from the SDK that signs, standing in for S3's own
 * decision. So "refused" below means the signature itself is refused, not
 * that a mock returned what the test expected.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PHOTO_URL_TTL_SECONDS,
  PHOTO_URL_WINDOW_SECONDS,
  __resetPhotoSigningClientForTests,
  photoUrlLifetime,
  signPhotoKey,
  signPhotoUrlsIn,
  storedPhotoKey,
} from '../../../src/services/photoAccess.js';
import { createPresignedGetOrigin } from '../../integration/support/presignedGetOrigin.js';

const CREDENTIALS = {
  accessKeyId: 'AKIATESTPHOTOSIGNER',
  secretAccessKey: 'test-secret-not-a-real-key',
  sessionToken: 'test-session-token',
};
const BUCKET = 'fg-images-test-0000';
const KEY = 'plants/hh-1/p-1/0b7c0a4e-1111-4222-8333-944455556666.jpg';
const REFERENCE = `https://familygreenhouse.example/${KEY}`;
const PHOTO = Buffer.from('jpeg bytes');

const ORIGINAL_ENV = { ...process.env };
const origin = createPresignedGetOrigin(CREDENTIALS, BUCKET, new Map([[KEY, PHOTO]]));

/** 12:07:30 — inside the 12:00–12:30 reuse window. */
const NOW = new Date('2026-09-18T12:07:30.000Z');
const SECOND = 1000;
const MINUTE = 60 * SECOND;
/** An environment that started long before NOW, so only the window decides. */
const STARTED_EARLY = Date.parse('2026-09-18T08:00:00.000Z');

beforeEach(() => {
  process.env.IMAGES_BUCKET = BUCKET;
  process.env.AWS_REGION = 'us-east-1';
  process.env.AWS_ACCESS_KEY_ID = CREDENTIALS.accessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = CREDENTIALS.secretAccessKey;
  process.env.AWS_SESSION_TOKEN = CREDENTIALS.sessionToken;
  __resetPhotoSigningClientForTests();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  __resetPhotoSigningClientForTests();
});

describe('storedPhotoKey — what counts as a stored photo reference', () => {
  it('reads the key from the path, whatever origin the reference was minted under', () => {
    for (const reference of [
      REFERENCE,
      `https://${BUCKET}.s3.amazonaws.com/${KEY}`,
      `https://greenhouse.old-domain.example/${KEY}`,
    ]) {
      expect(storedPhotoKey(reference)).toEqual({ key: KEY, householdId: 'hh-1' });
    }
  });

  it('refuses anything already signed, or carrying a query or fragment', () => {
    expect(storedPhotoKey(`${REFERENCE}?X-Amz-Signature=abc`)).toBeNull();
    expect(storedPhotoKey(`${REFERENCE}?v=1`)).toBeNull();
    expect(storedPhotoKey(`${REFERENCE}#x`)).toBeNull();
  });

  it('refuses every other shape', () => {
    for (const value of [
      'https://familygreenhouse.example/plants/hh-1/p-1',
      'https://familygreenhouse.example/plants/hh-1/p-1/a/b.jpg',
      'https://familygreenhouse.example/trash/plants/hh-1/p-1/x.jpg',
      'https://familygreenhouse.example/plants/../p-1/x.jpg',
      'https://familygreenhouse.example/plants/hh-1/%2E%2E/x.jpg',
      'ftp://familygreenhouse.example/plants/hh-1/p-1/x.jpg',
      'plants/hh-1/p-1/x.jpg',
      '',
      null,
      42,
    ]) {
      expect(storedPhotoKey(value), String(value)).toBeNull();
    }
  });
});

describe('photoUrlLifetime — how long a URL lives', () => {
  it('always leaves at least the TTL, and at most TTL plus one window', () => {
    for (let offset = 0; offset < PHOTO_URL_WINDOW_SECONDS; offset += 97) {
      const now = new Date(Date.parse('2026-09-18T12:00:00.000Z') + offset * SECOND);
      const lifetime = photoUrlLifetime({ now, environmentStartedAtMs: STARTED_EARLY })!;
      const left = (lifetime.expiresAt.getTime() - now.getTime()) / SECOND;
      expect(left).toBeGreaterThanOrEqual(PHOTO_URL_TTL_SECONDS);
      expect(left).toBeLessThanOrEqual(PHOTO_URL_TTL_SECONDS + PHOTO_URL_WINDOW_SECONDS);
    }
  });

  it('gives the same signing date and expiry to every call inside one window', () => {
    const a = photoUrlLifetime({ now: NOW, environmentStartedAtMs: STARTED_EARLY })!;
    const b = photoUrlLifetime({
      now: new Date(NOW.getTime() + 20 * MINUTE),
      environmentStartedAtMs: STARTED_EARLY,
    })!;
    expect(a.signingDate.toISOString()).toBe('2026-09-18T12:00:00.000Z');
    expect(b).toEqual(a);
  });

  it('never signs as of a moment before this environment started', () => {
    const startedAt = Date.parse('2026-09-18T12:05:00.000Z');
    const lifetime = photoUrlLifetime({ now: NOW, environmentStartedAtMs: startedAt })!;
    expect(lifetime.signingDate.getTime()).toBe(startedAt);
    expect(lifetime.expiresAt.getTime() - NOW.getTime()).toBeGreaterThanOrEqual(
      PHOTO_URL_TTL_SECONDS * SECOND
    );
  });

  it('never outlives notAfter', () => {
    const notAfter = new Date(NOW.getTime() + 10 * MINUTE);
    const lifetime = photoUrlLifetime({
      now: NOW,
      notAfter,
      environmentStartedAtMs: STARTED_EARLY,
    })!;
    expect(lifetime.expiresAt.getTime()).toBeLessThanOrEqual(notAfter.getTime());
  });

  it('grants nothing once notAfter has passed, or with under a second left', () => {
    expect(photoUrlLifetime({ now: NOW, notAfter: new Date(NOW.getTime() - 1) })).toBeNull();
    expect(photoUrlLifetime({ now: NOW, notAfter: new Date(NOW.getTime() + 500) })).toBeNull();
    expect(photoUrlLifetime({ now: NOW, notAfter: 'not a date' })).toBeNull();
  });

  it('with no window, signs as of now for exactly the TTL', () => {
    const lifetime = photoUrlLifetime({ now: NOW, windowSeconds: 0, ttlSeconds: 3600 })!;
    expect(lifetime.signingDate.getTime()).toBe(NOW.getTime());
    expect(lifetime.expiresIn).toBe(3600);
  });
});

describe('signPhotoKey — a URL S3 would honor, and then refuse', () => {
  it('is honored now, and refused once its expiry passes', async () => {
    const url = (await signPhotoKey(KEY, { now: NOW, environmentStartedAtMs: STARTED_EARLY }))!;
    expect(origin.get(url, NOW)).toMatchObject({ status: 200, key: KEY });

    const expiresAt = origin.expiresAt(url)!;
    expect(origin.get(url, new Date(expiresAt.getTime() - SECOND)).status).toBe(200);
    expect(origin.get(url, expiresAt)).toEqual({ status: 403, reason: 'expired' });
  });

  it('refuses the same object with no signature', () => {
    // The reference itself, pointed at the bucket: an anonymous read.
    expect(origin.get(`https://${BUCKET}.s3.us-east-1.amazonaws.com/${KEY}`, NOW)).toEqual({
      status: 403,
      reason: 'unsigned',
    });
  });

  it('refuses a signature moved to another key, or a stretched expiry', async () => {
    const url = (await signPhotoKey(KEY, { now: NOW, environmentStartedAtMs: STARTED_EARLY }))!;
    const otherKey = new URL(url);
    otherKey.pathname = '/plants/hh-2/p-9/0b7c0a4e-1111-4222-8333-944455556666.jpg';
    expect(origin.get(otherKey.toString(), NOW)).toEqual({ status: 403, reason: 'bad-signature' });

    const stretched = new URL(url);
    stretched.searchParams.set('X-Amz-Expires', '604800');
    expect(origin.get(stretched.toString(), NOW)).toEqual({
      status: 403,
      reason: 'bad-signature',
    });
  });

  it('negative control: the verifier refuses a URL signed with another secret', async () => {
    // If the verifier accepted this, every "honored" above would prove nothing.
    process.env.AWS_SECRET_ACCESS_KEY = 'a-different-secret';
    __resetPhotoSigningClientForTests();
    const url = (await signPhotoKey(KEY, { now: NOW, environmentStartedAtMs: STARTED_EARLY }))!;
    expect(origin.get(url, NOW)).toEqual({ status: 403, reason: 'bad-signature' });
  });

  it('mints the identical URL for repeat views inside a window, so the browser cache answers', async () => {
    const a = await signPhotoKey(KEY, { now: NOW, environmentStartedAtMs: STARTED_EARLY });
    const b = await signPhotoKey(KEY, {
      now: new Date(NOW.getTime() + 15 * MINUTE),
      environmentStartedAtMs: STARTED_EARLY,
    });
    expect(a).toBe(b);
  });

  it('tells the response to cache privately, for no longer than the TTL', async () => {
    const url = (await signPhotoKey(KEY, { now: NOW }))!;
    expect(new URL(url).searchParams.get('response-cache-control')).toBe(
      `private, max-age=${PHOTO_URL_TTL_SECONDS}`
    );
  });

  it('fails loudly, and fast, with no role credentials in the environment', async () => {
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    __resetPhotoSigningClientForTests();
    const started = Date.now();
    await expect(signPhotoKey(KEY, { now: NOW })).rejects.toThrow(/no role credentials/);
    // No fall-through to container or instance metadata lookups.
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('signPhotoUrlsIn — signing a response on its way out', () => {
  const scope = { householdIds: ['hh-1'] };

  it('signs every photo field, however deeply nested, and nothing else', async () => {
    const body = {
      plants: [{ id: 'p-1', name: 'Monstera', imageUrl: REFERENCE, notes: REFERENCE }],
      photo: { imageUrl: REFERENCE, caption: REFERENCE },
      brief: [{ photoUrl: REFERENCE }],
    };
    const result = await signPhotoUrlsIn(body, scope, { now: NOW });
    expect(result).toEqual({ signed: 3, unsigned: 0 });
    for (const url of [body.plants[0].imageUrl, body.photo.imageUrl, body.brief[0].photoUrl]) {
      expect(origin.get(url, NOW).status).toBe(200);
    }
    // A reference-shaped string in a free-text field is text, not a photo.
    expect(body.plants[0].notes).toBe(REFERENCE);
    expect(body.photo.caption).toBe(REFERENCE);
  });

  it('leaves a key from outside the scope as the reference, never signed', async () => {
    const foreign = `https://familygreenhouse.example/plants/hh-2/p-9/x.jpg`;
    const body = { imageUrl: foreign };
    const result = await signPhotoUrlsIn(body, scope, { now: NOW });
    expect(result).toEqual({ signed: 0, unsigned: 1 });
    expect(body.imageUrl).toBe(foreign);
  });

  it('signs nothing for a response with no household at all', async () => {
    const body = { imageUrl: REFERENCE };
    await signPhotoUrlsIn(body, { householdIds: [] }, { now: NOW });
    expect(body.imageUrl).toBe(REFERENCE);
  });

  it('never re-signs a URL that already carries a signature', async () => {
    const already = (await signPhotoKey(KEY, { now: NOW, windowSeconds: 0, ttlSeconds: 60 }))!;
    const body = { photoUrl: already };
    const result = await signPhotoUrlsIn(body, scope, { now: NOW });
    expect(result).toEqual({ signed: 0, unsigned: 0 });
    expect(body.photoUrl).toBe(already);
  });

  it('caps every URL at a public link’s end, and shows nothing once it has none left', async () => {
    const notAfter = new Date(NOW.getTime() + 5 * MINUTE);
    const body = { imageUrl: REFERENCE };
    await signPhotoUrlsIn(body, { ...scope, notAfter }, { now: NOW });
    expect(origin.expiresAt(body.imageUrl)!.getTime()).toBeLessThanOrEqual(notAfter.getTime());
    expect(origin.get(body.imageUrl, notAfter)).toEqual({ status: 403, reason: 'expired' });

    const ended = { imageUrl: REFERENCE as string | null };
    await signPhotoUrlsIn(ended, { ...scope, notAfter: new Date(NOW.getTime() - 1) }, { now: NOW });
    expect(ended.imageUrl).toBeNull();
  });

  it('keeps the reference when signing fails, so the page shows a broken photo, not no photo', async () => {
    delete process.env.AWS_ACCESS_KEY_ID;
    __resetPhotoSigningClientForTests();
    const body = { imageUrl: REFERENCE };
    const result = await signPhotoUrlsIn(body, scope, { now: NOW });
    expect(result).toEqual({ signed: 0, unsigned: 1 });
    expect(body.imageUrl).toBe(REFERENCE);
  });
});
