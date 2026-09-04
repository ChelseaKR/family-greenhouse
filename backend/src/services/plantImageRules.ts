/**
 * Rules for plant photo object keys, shared by every writer of the photo
 * timeline.
 *
 * These four things — the allowed content types, the size cap, the public URL
 * form, and the "is this a URL we actually issued for this plant" check — were
 * previously local to `handlers/plants/handler.ts`. Caretaker seats add a
 * second, unauthenticated writer (`handlers/caretakers/photos.ts`), and a
 * second copy of a security check is a check that drifts. One definition,
 * imported by both.
 *
 * The key shape is `plants/{householdId}/{plantId}/{uuid}.{ext}`, which is
 * what makes the confirm step safe: the household and plant are baked into the
 * prefix, so a confirm call can only ever attach an object that was minted for
 * that exact plant in that exact household.
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
 * Hard cap enforced at confirm time. The presigned PUT itself cannot bound
 * size, so this is where an oversized upload is rejected (and best-effort
 * removed) rather than attached. Keep in sync with the frontend's client-side
 * downscale target.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Public base URL for a stored image key. When ASSETS_BASE_URL is set
 * (production: the site origin, served via the CloudFront /plants/* behavior)
 * we mint `${ASSETS_BASE_URL}/plants/...`; otherwise (local dev) we fall back
 * to the raw S3 URL form.
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

/** A fresh, unique key for a new upload to this plant. */
export function mintImageKey(householdId: string, plantId: string, contentType: string): string {
  return `${imageKeyPrefix(householdId, plantId)}${uuid()}.${IMAGE_CONTENT_TYPES[contentType]}`;
}

/**
 * Resolve a client-supplied `imageUrl` back to the S3 key it names, but ONLY
 * when it is a URL we would have issued for this exact household + plant.
 * Returns null otherwise — no slashes, dots, query strings, or foreign
 * prefixes can smuggle a different object into a plant's timeline.
 */
export function resolveIssuedImageKey(
  householdId: string,
  plantId: string,
  imageUrl: string
): string | null {
  const keyPrefix = imageKeyPrefix(householdId, plantId);
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
