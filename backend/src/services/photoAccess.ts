/**
 * How a stored plant photo becomes something a browser can load.
 *
 * ## The one rule
 *
 * A plant photo is served ONLY through a short-lived signed URL. The images
 * bucket is private, CloudFront has no path to it (ADR 0033), and the URL
 * stored on a plant row — `${ASSETS_BASE_URL}/plants/{householdId}/{plantId}/{uuid}.{ext}`
 * — is a REFERENCE: it names the object, and loading it fetches nothing. Every
 * response that shows a photo carries an S3 presigned GET instead, minted for
 * the request that asked and expiring on its own.
 *
 * ## Where the signing happens
 *
 * At the response, not at the read. `middleware/photoUrls.ts` walks each JSON
 * body on its way out and replaces every stored reference under an `imageUrl`
 * or `photoUrl` field with a signed URL. Signing at the read (in the services)
 * would hand the signed form to code that writes it back — the cutting-share
 * snapshot copies `plant.imageUrl`, and an expiring URL stored there would rot
 * — and signing in each handler would leave the next surface to remember. A
 * surface that is missed at the response fails CLOSED: it shows a broken
 * image, because the reference serves nothing.
 *
 * ## Who may have a key signed
 *
 * Only a key inside a household the request is entitled to. A member route
 * signs keys under the caller's active household. A route that spans several
 * households, or a public link that answers for one, says so with
 * `scopePhotoUrls`. Anything else is left as the reference, never signed. The
 * check is what stops a stored-looking string that did not come from our own
 * storage from being turned into a working URL for somebody else's photo.
 *
 * ## Lifetimes
 *
 * A signature carries its own expiry, and a public link also caps it at the
 * link's own end (`notAfter`), so a photo in a sitter brief or on a cutting
 * link stops loading when the link does. The household app gets at least an
 * hour; the page asks for fresh URLs when one runs out.
 *
 * Two ceilings are outside our control and are why the lifetimes are short:
 * SigV4 caps a presigned URL at 7 days, and one signed with a Lambda's
 * temporary credentials also dies with that role session.
 */
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { requireEnv } from '../utils/env.js';
import { logger } from '../utils/logger.js';

/** Least time a household photo URL stays valid from the moment it is minted. */
export const PHOTO_URL_TTL_SECONDS = 60 * 60;

/**
 * How long one minted URL is reused before the next is minted. Within a window
 * the same object gets the same URL (same signing date, same expiry), so the
 * browser's cache answers a repeat view instead of downloading the photo
 * again. It is also the most a URL can outlive `PHOTO_URL_TTL_SECONDS` by.
 */
export const PHOTO_URL_WINDOW_SECONDS = 30 * 60;

/** SigV4's hard ceiling for a presigned URL. */
const SIGV4_MAX_EXPIRES_SECONDS = 7 * 24 * 60 * 60;

/**
 * When this execution environment loaded the module, to the second. Lambda
 * issues an environment's credentials before any module loads, so no signing
 * date at or after this can predate the credentials that sign it.
 */
const ENVIRONMENT_STARTED_AT_MS = Math.floor(Date.now() / 1000) * 1000;

/**
 * The only key shape this system mints for plant photos:
 * `plants/{householdId}/{plantId}/{uuid}.{ext}`. Four segments, no traversal.
 */
const PLANT_PHOTO_KEY_RE = /^plants\/([^/]+)\/[^/]+\/[^/]+$/;

export interface StoredPhotoKey {
  key: string;
  householdId: string;
}

/**
 * The S3 key a stored photo reference names, and the household it lives in.
 * Null for anything that is not a stored reference.
 *
 * The key comes from the URL's PATH, never from stripping `ASSETS_BASE_URL`:
 * a reference minted under an older origin (the raw S3 form used in dev, or a
 * previous site domain) must keep resolving, and the path is the stable part.
 *
 * A URL with a query string or fragment is refused. A stored reference never
 * has one, and a signed URL always does, so a value that has already been
 * signed is never signed again.
 */
export function storedPhotoKey(value: unknown): StoredPhotoKey | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    return null;
  }
  let key: string;
  try {
    key = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  } catch {
    return null;
  }
  const match = PLANT_PHOTO_KEY_RE.exec(key);
  if (!match || key.split('/').some((segment) => segment === '.' || segment === '..')) {
    return null;
  }
  return { key, householdId: match[1] };
}

export interface PhotoUrlLifetimeOptions {
  now?: Date;
  /** Least validity from `now`. Defaults to `PHOTO_URL_TTL_SECONDS`. */
  ttlSeconds?: number;
  /** Reuse window; 0 mints a fresh URL on every call. */
  windowSeconds?: number;
  /** A hard end the URL may never outlive, e.g. the link's own expiry. */
  notAfter?: string | Date | null;
  /** Test seam for the environment's start; see ENVIRONMENT_STARTED_AT_MS. */
  environmentStartedAtMs?: number;
}

export interface PhotoUrlLifetime {
  signingDate: Date;
  expiresIn: number;
  /** When the URL stops working, as S3 will compute it. */
  expiresAt: Date;
}

/**
 * The signing date and expiry for one URL, or null when there is no time
 * left to grant (a link in its final second, or already past `notAfter`).
 *
 * The signing date is the start of the current window, so every call inside
 * the window agrees on it — unless the window began before this environment
 * did, in which case it is the environment's start (see
 * ENVIRONMENT_STARTED_AT_MS). The expiry is window start + TTL + window, which
 * leaves at least TTL from `now` and at most TTL + window, then clamped to
 * `notAfter`.
 */
export function photoUrlLifetime(options: PhotoUrlLifetimeOptions = {}): PhotoUrlLifetime | null {
  const nowMs = (options.now ?? new Date()).getTime();
  const ttlMs = (options.ttlSeconds ?? PHOTO_URL_TTL_SECONDS) * 1000;
  const windowMs = (options.windowSeconds ?? PHOTO_URL_WINDOW_SECONDS) * 1000;
  const startedAtMs = options.environmentStartedAtMs ?? ENVIRONMENT_STARTED_AT_MS;

  const nowSecondMs = Math.floor(nowMs / 1000) * 1000;
  let signingMs = windowMs > 0 ? Math.floor(nowMs / windowMs) * windowMs : nowSecondMs;
  // Only when the environment started inside this window, never ahead of now:
  // a fixed clock in a test can sit before the process started.
  if (startedAtMs > signingMs && startedAtMs <= nowMs) signingMs = startedAtMs;

  let expiresAtMs = signingMs + ttlMs + windowMs;
  if (options.notAfter !== undefined && options.notAfter !== null) {
    const notAfterMs = new Date(options.notAfter).getTime();
    if (!Number.isFinite(notAfterMs)) return null;
    expiresAtMs = Math.min(expiresAtMs, notAfterMs);
  }
  const expiresIn = Math.min(
    SIGV4_MAX_EXPIRES_SECONDS,
    Math.floor((expiresAtMs - signingMs) / 1000)
  );
  const effectiveExpiryMs = signingMs + expiresIn * 1000;
  // A URL that would already be dead, or has under a second to live, is none.
  if (expiresIn < 1 || effectiveExpiryMs - nowMs < 1000) return null;
  return {
    signingDate: new Date(signingMs),
    expiresIn,
    expiresAt: new Date(effectiveExpiryMs),
  };
}

let client: S3Client | undefined;

/**
 * Signs with the function's own role, which Lambda hands to the process in
 * its environment. Read from the environment rather than the SDK's default
 * chain on purpose: the chain would fall through to network lookups (container
 * and instance metadata) wherever the variables are absent, and a missing
 * credential here should fail at once, loudly, rather than after a timeout.
 */
function signingClient(): S3Client {
  if (!client) {
    client = new S3Client({
      region: process.env.AWS_REGION || 'us-east-1',
      credentials: () => {
        const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
        const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
        if (!accessKeyId || !secretAccessKey) {
          return Promise.reject(new Error('photo signing: no role credentials in the environment'));
        }
        return Promise.resolve({
          accessKeyId,
          secretAccessKey,
          sessionToken: process.env.AWS_SESSION_TOKEN,
        });
      },
    });
  }
  return client;
}

/** Test seam: drop the cached client so a test's credentials take effect. */
export function __resetPhotoSigningClientForTests(): void {
  client = undefined;
}

/**
 * A presigned GET for one photo key, or null when the lifetime rules leave no
 * time to grant. Throws when signing itself fails (no credentials, no bucket);
 * callers decide what a failure means for their surface.
 *
 * The response is told to cache PRIVATELY for no longer than the TTL. Some
 * stored photos carry a year-long public `Cache-Control` of their own, and
 * that is not what a viewer's copy should keep.
 */
export async function signPhotoKey(
  key: string,
  options: PhotoUrlLifetimeOptions = {}
): Promise<string | null> {
  const lifetime = photoUrlLifetime(options);
  if (!lifetime) return null;
  const ttlSeconds = options.ttlSeconds ?? PHOTO_URL_TTL_SECONDS;
  return getSignedUrl(
    signingClient(),
    new GetObjectCommand({
      Bucket: requireEnv('IMAGES_BUCKET'),
      Key: key,
      ResponseCacheControl: `private, max-age=${ttlSeconds}`,
    }),
    { expiresIn: lifetime.expiresIn, signingDate: lifetime.signingDate }
  );
}

// ---------------------------------------------------------------------------
// Response-level signing
// ---------------------------------------------------------------------------

/** Which households a response may have photos signed for, and until when. */
export interface PhotoUrlScope {
  householdIds: readonly string[];
  /** The link's own end, for a public link. Null or absent for no cap. */
  notAfter?: string | Date | null;
}

const scopes = new WeakMap<object, PhotoUrlScope>();

/**
 * Declare what a response may sign. A handler calls this when the households
 * its response covers are not simply the caller's active one: a public link
 * (the link's household, capped at the link's expiry), or a view across every
 * household the caller belongs to.
 */
export function scopePhotoUrls(event: object, scope: PhotoUrlScope): void {
  scopes.set(event, scope);
}

/**
 * The scope a response is signed under: the declared one, else the
 * authenticated caller's active household, else nothing at all.
 */
export function photoUrlScopeFor(event: unknown): PhotoUrlScope {
  if (typeof event === 'object' && event !== null) {
    const declared = scopes.get(event);
    if (declared) return declared;
    const householdId = (event as { user?: { householdId?: unknown } }).user?.householdId;
    if (typeof householdId === 'string' && householdId.length > 0) {
      return { householdIds: [householdId] };
    }
  }
  return { householdIds: [] };
}

/** The response fields that hold a photo. Nothing else is ever rewritten. */
export const PHOTO_URL_FIELDS: ReadonlySet<string> = new Set(['imageUrl', 'photoUrl']);

export interface SignPhotoUrlsResult {
  /** References replaced with a signed URL. */
  signed: number;
  /** References left as they were: outside the scope, or signing failed. */
  unsigned: number;
}

/**
 * Replace, in place, every stored photo reference under a photo field of
 * `body` with a signed URL, as far as `scope` allows.
 *
 * A reference outside the scope, or one that fails to sign, is LEFT AS IT
 * IS. It serves nothing, so the page shows a broken image rather than a
 * missing one: a photo that exists is not reported as absent because we
 * failed to sign it. The one case that becomes null is a public link with no
 * time left, where showing nothing is the rule, not the failure.
 */
export async function signPhotoUrlsIn(
  body: unknown,
  scope: PhotoUrlScope,
  options: Omit<PhotoUrlLifetimeOptions, 'notAfter'> = {}
): Promise<SignPhotoUrlsResult> {
  const result: SignPhotoUrlsResult = { signed: 0, unsigned: 0 };
  const allowed = new Set(scope.householdIds);
  const pending: Promise<void>[] = [];
  // One signature per key per response: a plant and its latest timeline entry
  // usually name the same object.
  const cache = new Map<string, Promise<string | null>>();

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    const record = node as Record<string, unknown>;
    for (const [field, value] of Object.entries(record)) {
      if (typeof value === 'string') {
        if (!PHOTO_URL_FIELDS.has(field)) continue;
        const stored = storedPhotoKey(value);
        if (!stored) continue;
        if (!allowed.has(stored.householdId)) {
          result.unsigned += 1;
          logger.warn({ field }, 'photo_url.outside_scope');
          continue;
        }
        let signing = cache.get(stored.key);
        if (!signing) {
          signing = signPhotoKey(stored.key, { ...options, notAfter: scope.notAfter });
          cache.set(stored.key, signing);
        }
        pending.push(
          signing.then(
            (signed) => {
              if (signed) {
                record[field] = signed;
                result.signed += 1;
              } else {
                // No time left on the link: nothing to show, and nothing is.
                record[field] = null;
                result.unsigned += 1;
              }
            },
            (err: unknown) => {
              result.unsigned += 1;
              logger.error({ err: (err as Error).message, field }, 'photo_url.sign_failed');
            }
          )
        );
      } else {
        visit(value);
      }
    }
  };

  visit(body);
  await Promise.all(pending);
  return result;
}
