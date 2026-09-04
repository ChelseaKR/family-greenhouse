/**
 * Sitter photo-back — the I/O half: the per-link quota row, the S3 write,
 * and the per-token brake. Policy (sizes, sniffing, schema) is in
 * ./sitterPhotoPolicy.ts; the handler that orders the checks is
 * handlers/tasks/sitterPhotos.ts.
 *
 * Quota model: `photoCount` lives ON the sitter link row (`SITTER#{token}`,
 * SK METADATA), reserved with a single conditional `ADD` before any bytes
 * are stored. That makes the 60-photo cap atomic across concurrent uploads
 * and across Lambda containers — there is no read-then-write window in
 * which two uploads both see 59. A failed upload releases its slot
 * (best-effort; a leaked slot only makes the cap stricter, never looser).
 *
 * The per-token brake (in-memory, no I/O) lives with the policy in
 * ./sitterPhotoPolicy.ts so the mock dev server can share it.
 */
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { v4 as uuid } from 'uuid';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { s3, IMAGES_BUCKET, publicImageUrl } from '../utils/s3.js';
import { logger } from '../utils/logger.js';
import {
  SITTER_PHOTO_EXTENSIONS,
  SITTER_PHOTO_MAX_PER_LINK,
  type SitterPhotoContentType,
} from './sitterPhotoPolicy.js';

// ---------------------------------------------------------------------------
// Per-link quota (DynamoDB, atomic)
// ---------------------------------------------------------------------------

export type SlotReservation = { ok: true; used: number } | { ok: false; reason: 'cap_reached' };

function linkKey(token: string) {
  return { PK: `SITTER#${token}`, SK: 'METADATA' };
}

/**
 * Take one photo slot on the link, atomically. `ok: false` means the link
 * already holds `max` photos (or the row vanished — TTL-swept — which the
 * caller has already turned into a 404 via getActiveLink, so treating it as
 * "no slot" is the safe reading).
 */
export async function reserveSitterPhotoSlot(
  token: string,
  max = SITTER_PHOTO_MAX_PER_LINK
): Promise<SlotReservation> {
  try {
    const result = await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: linkKey(token),
        UpdateExpression: 'ADD photoCount :one',
        ConditionExpression:
          'attribute_exists(PK) AND (attribute_not_exists(photoCount) OR photoCount < :max)',
        ExpressionAttributeValues: { ':one': 1, ':max': max },
        ReturnValues: 'UPDATED_NEW',
      })
    );
    const used = Number(result.Attributes?.photoCount ?? 0);
    return { ok: true, used };
  } catch (err) {
    if ((err as Error).name === 'ConditionalCheckFailedException') {
      return { ok: false, reason: 'cap_reached' };
    }
    throw err;
  }
}

/**
 * Give a reserved slot back after a failed upload. Best-effort: a failure
 * here is logged, not thrown — the user-visible outcome is one fewer photo
 * allowed on this link, which is the safe direction for a quota.
 */
export async function releaseSitterPhotoSlot(token: string): Promise<void> {
  try {
    await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: linkKey(token),
        UpdateExpression: 'ADD photoCount :minusOne',
        ConditionExpression: 'attribute_exists(PK) AND photoCount > :zero',
        ExpressionAttributeValues: { ':minusOne': -1, ':zero': 0 },
      })
    );
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'sitter_photo.slot_release_failed');
  }
}

/** Photos already stored through this link (0 when none yet). Null when the
 *  row can't be read — callers must not render that as "0 used". */
export async function getSitterPhotoCount(token: string): Promise<number | null> {
  const result = await dynamodb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: linkKey(token),
      ProjectionExpression: 'photoCount',
    })
  );
  if (!result.Item) return null;
  return Number(result.Item.photoCount ?? 0);
}

// ---------------------------------------------------------------------------
// S3 object
// ---------------------------------------------------------------------------

export interface StoredSitterPhoto {
  key: string;
  imageUrl: string;
}

/**
 * Write the bytes under the household's EXISTING per-plant photo prefix
 * (`plants/{householdId}/{plantId}/{uuid}.{ext}` — the same key shape the
 * member upload flow mints), so plant deletion, account erasure, and the
 * DPIA's retention rules already cover sitter photos with no new branch.
 * The object carries `via-sitter` / `sitter-link-id` metadata so a stored
 * object is attributable on its own, without the DynamoDB row.
 */
export async function storeSitterPhoto(input: {
  householdId: string;
  plantId: string;
  linkId: string;
  bytes: Buffer;
  contentType: SitterPhotoContentType;
}): Promise<StoredSitterPhoto> {
  const ext = SITTER_PHOTO_EXTENSIONS[input.contentType];
  const key = `plants/${input.householdId}/${input.plantId}/${uuid()}.${ext}`;
  await s3.send(
    new PutObjectCommand({
      Bucket: IMAGES_BUCKET,
      Key: key,
      Body: input.bytes,
      ContentType: input.contentType,
      ContentLength: input.bytes.length,
      // Served same-origin via CloudFront — never let a browser sniff it
      // into something other than the image type we verified.
      CacheControl: 'public, max-age=31536000, immutable',
      Metadata: { 'via-sitter': 'true', 'sitter-link-id': input.linkId },
    })
  );
  return { key, imageUrl: publicImageUrl(key) };
}

/** Best-effort removal when a later step (the photo row) failed. */
export async function discardSitterPhoto(key: string): Promise<void> {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: IMAGES_BUCKET, Key: key }));
  } catch (err) {
    logger.warn({ err: (err as Error).message, key }, 'sitter_photo.discard_failed');
  }
}
