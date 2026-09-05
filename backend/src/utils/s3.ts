import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { requireEnv } from './env.js';

export const s3 = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
});

export const IMAGES_BUCKET = requireEnv('IMAGES_BUCKET');

/**
 * Public base URL for a stored image key. When ASSETS_BASE_URL is set
 * (production: the site origin, served via the CloudFront /plants/*
 * behavior) we mint `${ASSETS_BASE_URL}/plants/...`; otherwise (local dev)
 * the raw S3 URL form. Same rule the member upload flow in
 * handlers/plants/handler.ts applies at presign time.
 */
export function publicImageUrl(key: string): string {
  const base = process.env.ASSETS_BASE_URL?.replace(/\/+$/, '');
  if (base) return `${base}/${key}`;
  return `https://${IMAGES_BUCKET}.s3.amazonaws.com/${key}`;
}

/**
 * The only key shape this system mints for plant photos:
 * `plants/{householdId}/{plantId}/{uuid}.{ext}`. Four segments, no traversal.
 * Kept as a literal rather than derived so a change to the upload key shape
 * has to be made here too, deliberately.
 */
const PLANT_IMAGE_KEY_RE = /^plants\/[^/]+\/[^/]+\/[^/]+$/;

/**
 * Recover the S3 key from a stored image URL, and ONLY if the key belongs to
 * `householdId`. Returns null for anything else.
 *
 * The key is taken from the URL's path rather than by stripping
 * `ASSETS_BASE_URL`, because a URL minted under an older base (the raw S3 form
 * used in dev, or a previous asset domain) must still resolve — the path shape
 * is the stable part, the origin is not.
 *
 * The household check is the security boundary, not a tidiness check: it is
 * what stops a stored URL from being used to sign a read of some other
 * household's object.
 */
export function plantImageKeyForHousehold(imageUrl: string, householdId: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(imageUrl).pathname;
  } catch {
    return null;
  }
  let key: string;
  try {
    key = decodeURIComponent(pathname.replace(/^\/+/, ''));
  } catch {
    return null;
  }
  if (!PLANT_IMAGE_KEY_RE.test(key)) return null;
  if (!key.startsWith(`plants/${householdId}/`)) return null;
  return key;
}

/**
 * A time-boxed GET URL for one stored object. Signed with the Lambda's own
 * role, which holds `s3:GetObject` on the images bucket; the bucket's policy
 * grants CloudFront but denies nobody, so a signed request from the same
 * account is authorized by the identity policy.
 *
 * Note the real ceiling: SigV4 caps a presigned URL at 7 days, and one signed
 * with a Lambda's temporary credentials dies with the role session well before
 * that. Callers must therefore sign SHORT and re-sign on each request rather
 * than handing out something they expect to keep working — which is the
 * behaviour we want anyway.
 */
export async function signedImageUrl(key: string, expiresIn: number): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: IMAGES_BUCKET, Key: key }), { expiresIn });
}
