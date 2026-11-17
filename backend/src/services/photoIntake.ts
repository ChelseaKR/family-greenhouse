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
 *
 * Where the bytes go (ADR 0046). A client uploads to a holding key under
 * `uploads/`, through a URL signed for that key, that content type and that
 * exact byte count. The confirm step reads the holding object, checks and
 * cleans it, and writes the result to a new key under `plants/` that no
 * upload URL was ever signed for. The plant's photo is that second object, so
 * nothing a client can still send to the upload URL can change it. The
 * holding object is deleted, and the bucket's lifecycle rule removes any that
 * were never confirmed.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { IMAGES_BUCKET, s3 } from '../utils/s3.js';
import { logger } from '../utils/logger.js';
import { cleanPhoto, REFUSED_MESSAGES } from './photoClean.js';
import {
  IMAGE_CONTENT_TYPES,
  MAX_IMAGE_BYTES,
  mintImageKey,
  mintUploadKey,
  publicImageUrl,
  resolveIssuedUploadKey,
  UPLOAD_URL_TTL_SECONDS,
} from './plantImageRules.js';

export { cleanPhoto, REFUSED_MESSAGES } from './photoClean.js';

/** What a presign route hands the client. */
export interface PhotoUploadGrant {
  /** Presigned PUT for the holding key. */
  uploadUrl: string;
  /** The reference the confirm call sends back. It names the upload, and loads nothing. */
  imageUrl: string;
}

/** What a presign route's request body may carry. */
export interface PhotoUploadRequest {
  contentType?: string;
  contentLength?: number;
}

/** Shown to a client that asks for an upload without saying how big it is. */
export const UPLOAD_NEEDS_SIZE_MESSAGE =
  "This version of the app can't add photos. Reload the page or update the app, then try again.";

/**
 * Read a presign request: the content type (JPEG when absent, as it always
 * was) and the declared size, which is required and capped. A request with
 * no size comes from a client older than the signed-size contract; it is
 * refused, because an upload URL with no size in it bounds nothing.
 */
export function readUploadRequest(
  body: PhotoUploadRequest | null | undefined
): { ok: true; contentType: string; contentLength: number } | { ok: false; message: string } {
  const contentType = body?.contentType ?? 'image/jpeg';
  const contentLength = body?.contentLength;
  if (contentLength === undefined) return { ok: false, message: UPLOAD_NEEDS_SIZE_MESSAGE };
  if (contentLength > MAX_IMAGE_BYTES) {
    return { ok: false, message: 'Image exceeds the 5 MiB limit' };
  }
  return { ok: true, contentType, contentLength };
}

/**
 * Sign one upload: a PUT to a fresh holding key, for exactly `contentType`
 * and exactly `contentLength` bytes.
 *
 * Both headers are in the signature, so storage refuses a request whose
 * Content-Type or Content-Length differs from what was declared here. The
 * presigner leaves Content-Type out of a signature unless it is named, which
 * is why `signableHeaders` lists it; Content-Length is signed whenever the
 * command carries one, and is listed so that never depends on a default.
 * Callers validate `contentLength` against MAX_IMAGE_BYTES before this.
 */
export async function presignPhotoUpload(input: {
  householdId: string;
  plantId: string;
  contentType: string;
  contentLength: number;
}): Promise<PhotoUploadGrant> {
  const key = mintUploadKey(input.householdId, input.plantId, input.contentType);
  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: IMAGES_BUCKET,
      Key: key,
      ContentType: input.contentType,
      ContentLength: input.contentLength,
    }),
    {
      expiresIn: UPLOAD_URL_TTL_SECONDS,
      signableHeaders: new Set(['content-type', 'content-length']),
    }
  );
  return { uploadUrl, imageUrl: publicImageUrl(key) };
}

export type AcceptUploadResult =
  | {
      ok: true;
      /** The stored photo's key, under `plants/`. */
      key: string;
      /** The stored photo's reference, to put on the plant. */
      imageUrl: string;
      /** True when metadata was removed on the way. */
      changed: boolean;
    }
  | { ok: false; status: 400; message: string };

function isMissingObject(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}

/**
 * Remove one version of an object for good. With a version id this deletes
 * that version, not just the current key (in the versioned production bucket
 * a plain delete would only add a marker and keep the bytes until the
 * lifecycle rule removes them).
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

async function discardUpload(key: string, versionId: string | undefined, why: string) {
  await removeVersion(key, versionId).catch((err: unknown) => {
    // The bucket's lifecycle rule removes it within a day anyway.
    logger.warn({ err: (err as Error).message, why }, 'photo_intake.upload_delete_failed');
  });
}

/**
 * Check an uploaded photo and store it as a plant photo.
 *
 * `imageUrl` is the reference the presign route returned. The holding object
 * it names must exist, be within the size cap, carry an allowed content type
 * and BE that type; anything else is refused and deleted. What is kept is
 * written, without its metadata, to a new key under `plants/` that only this
 * function knows, conditionally on that key not existing. The holding object
 * is then deleted.
 *
 * The caller attaches `imageUrl` from the result to the plant, never the one
 * the client sent.
 *
 * Logs booleans and sizes only: never a key's contents, a coordinate or a
 * place name.
 */
export async function acceptUploadedPhoto(
  householdId: string,
  plantId: string,
  imageUrl: string
): Promise<AcceptUploadResult> {
  const uploadKey = resolveIssuedUploadKey(householdId, plantId, imageUrl);
  if (!uploadKey) {
    return {
      ok: false,
      status: 400,
      message: 'imageUrl does not match a key issued for this plant',
    };
  }

  let contentLength: number | undefined;
  let contentType: string | undefined;
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: IMAGES_BUCKET, Key: uploadKey }));
    contentLength = head.ContentLength;
    contentType = head.ContentType;
  } catch (err) {
    if (!isMissingObject(err)) throw err;
    return {
      ok: false,
      status: 400,
      message: 'Uploaded image not found; upload it before confirming',
    };
  }
  if (contentLength === undefined || contentLength === 0 || contentLength > MAX_IMAGE_BYTES) {
    await discardUpload(uploadKey, undefined, 'size');
    return {
      ok: false,
      status: 400,
      message: contentLength === 0 ? 'Uploaded image is empty' : 'Image exceeds the 5 MiB limit',
    };
  }
  if (!contentType || !(contentType in IMAGE_CONTENT_TYPES)) {
    await discardUpload(uploadKey, undefined, 'content_type');
    return { ok: false, status: 400, message: 'Uploaded file is not a valid image' };
  }

  const object = await s3.send(new GetObjectCommand({ Bucket: IMAGES_BUCKET, Key: uploadKey }));
  if (!object.Body) {
    return {
      ok: false,
      status: 400,
      message: 'Uploaded image not found; upload it before confirming',
    };
  }
  const bytes = await object.Body.transformToByteArray();
  // The object read is the one that is checked: its own size and type, not
  // the ones seen a moment earlier.
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    await discardUpload(uploadKey, object.VersionId, 'size');
    return {
      ok: false,
      status: 400,
      message: bytes.length === 0 ? 'Uploaded image is empty' : 'Image exceeds the 5 MiB limit',
    };
  }
  const declaredType = object.ContentType ?? contentType;
  const clean = cleanPhoto(bytes, declaredType);
  if (!clean.ok) {
    await discardUpload(uploadKey, object.VersionId, clean.reason);
    logger.info({ reason: clean.reason, bytes: bytes.length }, 'photo_intake.refused');
    return { ok: false, status: 400, message: REFUSED_MESSAGES[clean.reason] };
  }

  const key = mintImageKey(householdId, plantId, clean.format);
  await s3.send(
    new PutObjectCommand({
      Bucket: IMAGES_BUCKET,
      Key: key,
      Body: clean.bytes,
      ContentType: clean.format,
      ContentLength: clean.bytes.length,
      // Served only through short-lived signed URLs (ADR 0033), which also
      // set this per response; a copy is the viewer's own, and brief.
      CacheControl: 'private, max-age=3600',
      // A fresh UUID cannot already exist; if it somehow does, fail rather
      // than replace a stored photo.
      IfNoneMatch: '*',
    })
  );
  await discardUpload(uploadKey, object.VersionId, 'accepted');

  logger.info(
    {
      format: clean.format,
      hadLocation: clean.hadLocation,
      metadataRemoved: clean.changed,
      bytesBefore: bytes.length,
      bytesAfter: clean.bytes.length,
    },
    'photo_intake.accepted'
  );
  return { ok: true, key, imageUrl: publicImageUrl(key), changed: clean.changed };
}

/**
 * Best-effort removal of a photo `acceptUploadedPhoto` stored, when the step
 * after it (the photo row) failed, so no object is left that no row names.
 */
export async function discardAcceptedPhoto(key: string): Promise<void> {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: IMAGES_BUCKET, Key: key }));
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'photo_intake.accepted_delete_failed');
  }
}
