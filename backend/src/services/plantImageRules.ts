/**
 * Rules for plant photo object keys, shared by every writer of the photo
 * timeline.
 *
 * These four things — the allowed content types, the size cap, the public URL
 * form, and the "is this an upload we actually issued for this plant" check — were
 * previously local to `handlers/plants/handler.ts`. Caretaker seats add a
 * second, unauthenticated writer (`handlers/caretakers/photos.ts`), and a
 * second copy of a security check is a check that drifts. One definition,
 * imported by both.
 *
 * Two key shapes, one for each side of the check (ADR 0046):
 *
 *   - `uploads/{householdId}/{plantId}/{uuid}.{ext}` is where a client's
 *     upload lands. It is the only shape an upload URL is ever signed for,
 *     nothing under it is ever served, and the bucket deletes whatever is
 *     left there after a day.
 *   - `plants/{householdId}/{plantId}/{uuid}.{ext}` is where a photo lives.
 *     Only the server writes there, after its own checks, under a name no
 *     client was told in advance.
 *
 * The household and plant are baked into both prefixes, so a confirm call can
 * only ever attach an object that was minted for that exact plant in that
 * exact household.
 */
import { v4 as uuid } from 'uuid';
import { IMAGES_BUCKET } from '../utils/s3.js';

/** Content types we presign for, mapped to the extension the key carries. */
export const IMAGE_CONTENT_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * Hard cap on a plant photo. The upload URL is signed for the exact byte
 * count the client declared, which may not exceed this, and the confirm step
 * checks the stored object against it again. Keep in sync with the
 * frontend's client-side downscale target.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** How long an upload URL can be used. */
export const UPLOAD_URL_TTL_SECONDS = 300;

/**
 * The stored reference for an image key: `${ASSETS_BASE_URL}/plants/...` when
 * ASSETS_BASE_URL is set (production: the site origin), otherwise (local dev)
 * the raw S3 URL form. It names the object and serves nothing; a photo is
 * shown only through a signed URL minted per response (ADR 0033).
 */
export function publicImageUrl(key: string): string {
  const base = process.env.ASSETS_BASE_URL?.replace(/\/+$/, '');
  if (base) return `${base}/${key}`;
  return `https://${IMAGES_BUCKET}.s3.amazonaws.com/${key}`;
}

/** The prefix every object for this plant must live under. */
export function imageKeyPrefix(householdId: string, plantId: string): string {
  return `plants/${householdId}/${plantId}/`;
}

/** A fresh, unique key for a photo the server has checked. Never presigned. */
export function mintImageKey(householdId: string, plantId: string, contentType: string): string {
  return `${imageKeyPrefix(householdId, plantId)}${uuid()}.${IMAGE_CONTENT_TYPES[contentType]}`;
}

/** The holding prefix an upload for this plant lands under. */
export function uploadKeyPrefix(householdId: string, plantId: string): string {
  return `uploads/${householdId}/${plantId}/`;
}

/** A fresh, unique holding key for one upload to this plant. */
export function mintUploadKey(householdId: string, plantId: string, contentType: string): string {
  return `${uploadKeyPrefix(householdId, plantId)}${uuid()}.${IMAGE_CONTENT_TYPES[contentType]}`;
}

/**
 * Resolve a client-supplied `imageUrl` back to the holding key it names, but
 * ONLY when it is a URL we would have issued for an upload to this exact
 * household + plant. Returns null otherwise — no slashes, dots, query
 * strings, or foreign prefixes can smuggle a different object into a plant's
 * timeline, and a key under `plants/` (a stored photo) is not an upload.
 */
export function resolveIssuedUploadKey(
  householdId: string,
  plantId: string,
  imageUrl: string
): string | null {
  const keyPrefix = uploadKeyPrefix(householdId, plantId);
  // Accept whichever URL forms we can mint; both map to the same S3 key.
  const assetsBase = process.env.ASSETS_BASE_URL?.replace(/\/+$/, '');
  const expectedPrefixes = [`https://${IMAGES_BUCKET}.s3.amazonaws.com/${keyPrefix}`];
  if (assetsBase) expectedPrefixes.unshift(`${assetsBase}/${keyPrefix}`);
  const matchedPrefix = expectedPrefixes.find((p) => imageUrl.startsWith(p));
  if (!matchedPrefix) return null;

  // The remainder must look exactly like a key we minted (uuid.ext).
  const filename = imageUrl.slice(matchedPrefix.length);
  if (!/^[A-Za-z0-9-]+\.(jpg|png|webp)$/.test(filename)) return null;
  return `${keyPrefix}${filename}`;
}
