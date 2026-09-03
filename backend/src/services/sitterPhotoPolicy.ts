/**
 * Sitter photo-back — the pure policy half (no AWS, no I/O).
 *
 * A plant sitter holds a 256-bit link token and nothing else. Letting that
 * token WRITE bytes into the household's photo store is the one place the
 * Away Kit widens the unauthenticated surface, so every limit that bounds
 * the blast radius lives here, in one dependency-free module that both the
 * Lambda handler (handlers/tasks/sitterPhotos.ts) and the mock dev server
 * (local-server.ts) import — the two can't drift.
 *
 *   - `SITTER_PHOTO_MAX_PER_LINK`  hard cap per link, enforced atomically in
 *                                  DynamoDB (sitterPhotoService.reserve…).
 *   - `SITTER_PHOTO_MAX_BYTES`     per-file cap on the DECODED bytes — what
 *                                  actually lands in S3, not the base64 text.
 *   - `sniffImageContentType`      the content type comes from the magic
 *                                  bytes, never from a client header. A
 *                                  non-image payload (an HTML file renamed
 *                                  .jpg, a script) is refused before any
 *                                  storage call.
 *   - `decodeImagePayload`         strict base64 (charset + padding), so a
 *                                  body that Buffer would silently "decode"
 *                                  into garbage is a 400, not a stored blob.
 *
 * Marginal cost per household per month at the cap: 60 × 300 KB = 18 MB of
 * S3 Standard at $0.023/GB-month ≈ $0.0004 — the number in the ideation
 * brief (§4.1). The cap is what makes that number a ceiling, not an estimate.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const SITTER_PHOTO_MAX_PER_LINK = 60;
export const SITTER_PHOTO_MAX_BYTES = 300 * 1024; // 307,200 bytes decoded
export const SITTER_PHOTO_CAPTION_MAX = 200;
/** Uploads per token per minute (per warm container — see rateLimit.ts). */
export const SITTER_PHOTO_UPLOADS_PER_MINUTE = 10;

/**
 * Base64 text for the largest accepted file: every 3 bytes → 4 chars.
 * A data-URL prefix (`data:image/webp;base64,`) is ≤ 23 chars; allow a
 * little slack for it so the schema, not the body guard, rejects a
 * fractionally-too-large photo with a readable message.
 */
export const SITTER_PHOTO_MAX_BASE64_CHARS = Math.ceil(SITTER_PHOTO_MAX_BYTES / 3) * 4; // 409,600
const DATA_URL_PREFIX_SLACK = 32;

/**
 * Body guard for the upload route: the base64 text above plus the JSON
 * envelope (taskId, caption, field names). Anything larger is refused by
 * `bodySizeGuard` before the JSON parser runs.
 */
export const SITTER_PHOTO_BODY_MAX_BYTES = 420 * 1024;

export type SitterPhotoContentType = 'image/jpeg' | 'image/png' | 'image/webp';

export const SITTER_PHOTO_EXTENSIONS: Record<SitterPhotoContentType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * Identify the image container from its first bytes. Returns null for
 * anything that is not one of the three types the plant-photo pipeline
 * already allowlists (handlers/plants/handler.ts IMAGE_CONTENT_TYPES).
 *
 *   JPEG  FF D8 FF
 *   PNG   89 50 4E 47 0D 0A 1A 0A
 *   WebP  "RIFF" .... "WEBP"
 */
export function sniffImageContentType(bytes: Uint8Array): SitterPhotoContentType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  ) {
    return 'image/webp';
  }
  return null;
}

const DATA_URL = /^data:image\/[a-z0-9.+-]+;base64,/i;
const STRICT_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Decode a data URL or bare base64 string into bytes. Strict: the text must
 * be canonical base64 (no whitespace, no URL-safe alphabet, correct padding)
 * or the result is null. `Buffer.from(s, 'base64')` alone is lenient — it
 * skips invalid characters — which would let a malformed body decode into
 * something we then store.
 */
export function decodeImagePayload(image: string): Buffer | null {
  const bare = image.replace(DATA_URL, '');
  if (bare.length === 0 || bare.length % 4 !== 0 || !STRICT_BASE64.test(bare)) return null;
  return Buffer.from(bare, 'base64');
}

export type SitterPhotoRejection =
  | { ok: true; bytes: Buffer; contentType: SitterPhotoContentType }
  | { ok: false; status: 400 | 413; message: string };

/**
 * Full server-side admission check for one upload body: strict decode →
 * non-empty → size cap → magic bytes. Returns the bytes + sniffed type on
 * success, or the HTTP status + message to answer with. Pure, so the
 * handler and the mock server share one decision and the tests can cover
 * every branch without a Lambda event.
 */
export function admitSitterPhoto(image: string): SitterPhotoRejection {
  const bytes = decodeImagePayload(image);
  if (!bytes || bytes.length === 0) {
    return { ok: false, status: 400, message: 'Photo must be a base64-encoded image' };
  }
  if (bytes.length > SITTER_PHOTO_MAX_BYTES) {
    return {
      ok: false,
      status: 413,
      message: `Photo exceeds the ${Math.floor(SITTER_PHOTO_MAX_BYTES / 1024)} KB limit`,
    };
  }
  const contentType = sniffImageContentType(bytes);
  if (!contentType) {
    return { ok: false, status: 400, message: 'Photo is not a JPEG, PNG, or WebP image' };
  }
  return { ok: true, bytes, contentType };
}

export const sitterPhotoUploadSchema = z.object({
  /** The task the sitter is photographing; resolved to a plant server-side,
   *  scoped to the token's household. The sitter view never exposes plant
   *  ids, and a taskId from another household simply isn't found. */
  taskId: z.string().min(1).max(100),
  /** Data URL or bare base64. Size is re-checked on the DECODED bytes. */
  image: z
    .string()
    .min(64)
    .max(SITTER_PHOTO_MAX_BASE64_CHARS + DATA_URL_PREFIX_SLACK, 'Photo exceeds the 300 KB limit'),
  caption: z.string().trim().max(SITTER_PHOTO_CAPTION_MAX).optional(),
});
export type SitterPhotoUploadInput = z.infer<typeof sitterPhotoUploadSchema>;

/** Synthetic actor id for anything a sitter link does — mirrors the task
 *  completion route, so one recap query finds both. */
export function sitterActorId(linkId: string): string {
  return `sitter:${linkId}`;
}

// ---------------------------------------------------------------------------
// Per-token brake (in-memory, per warm container)
// ---------------------------------------------------------------------------
//
// Keyed by a hash of the token so the secret is never a Map key (heap dumps,
// debuggers). Same caveat as middleware/rateLimit.ts: per warm container, so
// a brake on one hot link, not a global cap. The global cap is the atomic
// DynamoDB counter in sitterPhotoService.

interface UploadWindow {
  count: number;
  resetAt: number;
}

const tokenWindows = new Map<string, UploadWindow>();
const WINDOW_MS = 60_000;
const SWEEP_SIZE = 2_000;

function tokenKey(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 32);
}

/**
 * Take one upload from the token's minute window. Returns false when the
 * token has already uploaded `max` photos this minute on this container.
 */
export function takeSitterPhotoToken(
  token: string,
  max = SITTER_PHOTO_UPLOADS_PER_MINUTE,
  now = Date.now()
): boolean {
  if (tokenWindows.size > SWEEP_SIZE) {
    for (const [k, w] of tokenWindows) if (w.resetAt <= now) tokenWindows.delete(k);
  }
  const key = tokenKey(token);
  const existing = tokenWindows.get(key);
  if (!existing || existing.resetAt <= now) {
    tokenWindows.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (existing.count >= max) return false;
  existing.count += 1;
  return true;
}

/** Test hook — drops every in-memory per-token window. */
export function __resetSitterPhotoLimiterForTests(): void {
  tokenWindows.clear();
}
