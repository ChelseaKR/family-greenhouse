/**
 * The server's own metadata strip for every plant photo it stores.
 *
 * #849 removes a photo's metadata on the device before it is uploaded, and
 * that stays the first line. It cannot be the only one: an app build from
 * before #849 is still installed on phones and still uploads the file as it
 * was picked, and any client that talks to the API directly uploads whatever
 * it likes. So the server checks every photo again before it attaches one to
 * a plant:
 *
 *   - the bytes must BE the image type the upload declared (JPEG, PNG or
 *     WebP). Anything else is refused and deleted, whatever its extension or
 *     Content-Type said. That includes HEIC, the format iPhones store photos
 *     in: no client this product ships sends one, and there is no way to strip
 *     it here without decoding it;
 *   - every EXIF, XMP and IPTC block is removed, GPS included, along with any
 *     image appended after a JPEG's end marker. A JPEG keeps one thing, its
 *     orientation, so a photo shot sideways does not turn sideways
 *     (services/photoMetadata.ts has the rules, shared with the operator
 *     backfill for photos stored before this);
 *   - the result is read back, and kept only if it carries nothing but that
 *     orientation. A photo this cannot parse is refused, never stored as it
 *     came: the same rule the device applies.
 *
 * Image data is copied byte for byte and never re-encoded, so a clean photo
 * comes out identical and is not written again.
 *
 * Why at confirm time rather than in an S3-triggered processor: a processor
 * runs after the object is already stored, so for a moment the photo would
 * sit there with its metadata, and the processor would be one more function,
 * trigger and permission to keep running. The confirm step already reads the
 * object's size and type before it attaches anything, so the photo is clean
 * before any response can show it. The sitter's photo-back route receives the
 * bytes in its request body and cleans them before they are stored at all.
 */
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { IMAGES_BUCKET, s3 } from '../utils/s3.js';
import { logger } from '../utils/logger.js';
import { cleanPhoto, REFUSED_MESSAGES } from './photoClean.js';

export { cleanPhoto, REFUSED_MESSAGES } from './photoClean.js';

export type SanitizeUploadResult =
  { ok: true; changed: boolean } | { ok: false; status: 400 | 409; message: string };

function isConditionalWriteLost(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  const status = e?.$metadata?.httpStatusCode;
  return (
    e?.name === 'PreconditionFailed' ||
    e?.name === 'ConditionalRequestConflict' ||
    status === 412 ||
    status === 409
  );
}

/**
 * Remove one version of an object for good. With a version id this deletes
 * that version, not just the current key (in the versioned production bucket
 * a plain delete would only add a marker and keep the bytes for 30 days).
 */
async function removeVersion(key: string, versionId: string | undefined): Promise<void> {
  await s3.send(
    new DeleteObjectCommand({
      Bucket: IMAGES_BUCKET,
      Key: key,
      ...(versionId && versionId !== 'null' ? { VersionId: versionId } : {}),
    })
  );
}

/**
 * Clean an uploaded photo in place, before it is attached to a plant.
 *
 * Reads the object, refuses (and deletes) anything that is not the declared
 * image type or cannot be cleaned, and writes the cleaned bytes back under the
 * same key when anything was removed. The write is conditional on the object
 * being the one just read, so a second upload to the same key in between is
 * never overwritten with the first one's pixels; that case is refused as 409.
 * In a versioned bucket the original becomes an old version the moment it is
 * rewritten, so that version is then deleted too.
 *
 * Logs booleans and sizes only: never a key's contents, a coordinate or a
 * place name.
 */
export async function sanitizeUploadedPhoto(
  key: string,
  declaredType: string
): Promise<SanitizeUploadResult> {
  const object = await s3.send(new GetObjectCommand({ Bucket: IMAGES_BUCKET, Key: key }));
  if (!object.Body) {
    return { ok: false, status: 400, message: 'Uploaded image not found; upload it again' };
  }
  const bytes = await object.Body.transformToByteArray();
  const clean = cleanPhoto(bytes, declaredType);

  if (!clean.ok) {
    await removeVersion(key, object.VersionId).catch((err: unknown) => {
      logger.warn({ err: (err as Error).message }, 'photo_intake.refused_delete_failed');
    });
    logger.info({ reason: clean.reason, bytes: bytes.length }, 'photo_intake.refused');
    return { ok: false, status: 400, message: REFUSED_MESSAGES[clean.reason] };
  }
  if (!clean.changed) return { ok: true, changed: false };

  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: IMAGES_BUCKET,
        Key: key,
        Body: clean.bytes,
        ContentType: clean.format,
        ContentLength: clean.bytes.length,
        CacheControl: object.CacheControl,
        Metadata: object.Metadata,
        IfMatch: object.ETag,
      })
    );
  } catch (err) {
    if (!isConditionalWriteLost(err)) throw err;
    await removeVersion(key, undefined).catch(() => undefined);
    return {
      ok: false,
      status: 409,
      message: 'The photo changed while it was being checked. Upload it again.',
    };
  }

  if (object.VersionId && object.VersionId !== 'null') {
    await removeVersion(key, object.VersionId).catch((err: unknown) => {
      // The bucket's lifecycle rule removes old versions after 30 days anyway.
      logger.warn({ err: (err as Error).message }, 'photo_intake.original_version_delete_failed');
    });
  }
  logger.info(
    {
      format: clean.format,
      hadLocation: clean.hadLocation,
      bytesBefore: bytes.length,
      bytesAfter: clean.bytes.length,
    },
    'photo_intake.metadata_removed'
  );
  return { ok: true, changed: true };
}
