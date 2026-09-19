/**
 * A stand-in for the private images bucket, as a browser would meet it.
 *
 * S3 is the enforcer in production: with every public access block set and no
 * bucket-policy grant (infrastructure/modules/frontend/main.tf), it answers a
 * GET only when the request carries a valid SigV4 query signature from a
 * principal that may read the object, and only until that signature expires.
 * No test can reach S3, so this module models exactly that decision, written
 * from the SigV4 specification with node:crypto rather than with the AWS SDK
 * that MINTS the URLs — a verifier built from the signer would agree with any
 * bug the signer has.
 *
 * It holds one set of credentials (the fake role the tests sign with) and a
 * map of object bytes, and answers:
 *
 *   403 unsigned      no signature at all: an anonymous read of a private bucket
 *   403 expired       X-Amz-Date + X-Amz-Expires is in the past
 *   403 bad-signature anything altered, or signed by someone else
 *   404 missing       signed correctly, no such object
 *   200               the bytes
 */
import { createHash, createHmac } from 'node:crypto';

export interface OriginCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export type OriginVerdict =
  | { status: 200; key: string; bytes: Buffer }
  | { status: 403; reason: 'unsigned' | 'expired' | 'bad-signature' }
  | { status: 404; reason: 'missing' };

/** RFC 3986 unreserved-only encoding, as SigV4 canonicalization requires. */
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

/** `20260918T120000Z` → epoch ms, or NaN. */
function amzDateMs(value: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!m) return Number.NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

export function createPresignedGetOrigin(
  credentials: OriginCredentials,
  bucket: string,
  objects: Map<string, Buffer> = new Map()
) {
  function get(rawUrl: string, now: Date = new Date()): OriginVerdict {
    const url = new URL(rawUrl);
    const params = url.searchParams;
    const signature = params.get('X-Amz-Signature');
    const credential = params.get('X-Amz-Credential');
    const amzDate = params.get('X-Amz-Date');
    const expires = params.get('X-Amz-Expires');
    const signedHeaders = params.get('X-Amz-SignedHeaders');
    if (!signature || !credential || !amzDate || !expires || !signedHeaders) {
      return { status: 403, reason: 'unsigned' };
    }
    if (params.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256') {
      return { status: 403, reason: 'bad-signature' };
    }

    // The URL must name this bucket, virtual-hosted style.
    if (!url.hostname.startsWith(`${bucket}.s3.`)) return { status: 403, reason: 'bad-signature' };

    const [accessKeyId, scopeDate, region, service, terminator] = credential.split('/');
    if (
      accessKeyId !== credentials.accessKeyId ||
      service !== 's3' ||
      terminator !== 'aws4_request' ||
      !amzDate.startsWith(scopeDate) ||
      (params.get('X-Amz-Security-Token') ?? undefined) !== credentials.sessionToken
    ) {
      return { status: 403, reason: 'bad-signature' };
    }
    if (signedHeaders !== 'host') return { status: 403, reason: 'bad-signature' };

    // Signature first, then expiry: an unsigned guess learns nothing either way.
    const canonicalQuery = [...params.entries()]
      .filter(([name]) => name !== 'X-Amz-Signature')
      .map(([name, value]) => [rfc3986(name), rfc3986(value)] as const)
      .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
      .map(([name, value]) => `${name}=${value}`)
      .join('&');
    const canonicalRequest = [
      'GET',
      url.pathname,
      canonicalQuery,
      `host:${url.host}\n`,
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n');
    const scope = `${scopeDate}/${region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join(
      '\n'
    );
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, scopeDate), region), 's3'),
      'aws4_request'
    );
    const expected = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
    if (expected !== signature) return { status: 403, reason: 'bad-signature' };

    const signedAt = amzDateMs(amzDate);
    const lifetime = Number.parseInt(expires, 10);
    if (!Number.isFinite(signedAt) || !Number.isFinite(lifetime) || lifetime < 1) {
      return { status: 403, reason: 'bad-signature' };
    }
    if (now.getTime() >= signedAt + lifetime * 1000) return { status: 403, reason: 'expired' };

    const key = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    const bytes = objects.get(key);
    if (!bytes) return { status: 404, reason: 'missing' };
    return { status: 200, key, bytes };
  }

  /** When S3 would stop honoring this URL, or null for an unsigned one. */
  function expiresAt(rawUrl: string): Date | null {
    const params = new URL(rawUrl).searchParams;
    const amzDate = params.get('X-Amz-Date');
    const expires = params.get('X-Amz-Expires');
    if (!amzDate || !expires) return null;
    return new Date(amzDateMs(amzDate) + Number.parseInt(expires, 10) * 1000);
  }

  return { get, expiresAt, objects };
}
