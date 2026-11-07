import { X509Certificate, verify as verifySignature } from 'node:crypto';

/**
 * Verifies Apple's signed data (JWS) for In-App Purchase (ADR 0041):
 * StoreKit 2 transactions and renewal info the app posts, and App Store
 * Server Notifications v2.
 *
 * Every one is a compact JWS signed ES256 by a leaf certificate whose chain
 * (in the `x5c` header) runs leaf -> Apple WWDR intermediate -> Apple Root CA
 * G3. Trust comes only from the root pinned below, never from the header:
 * the header is attacker-supplied, so the root it carries must equal the
 * pinned bytes, each certificate must be signed by the next, the two Apple
 * marker extensions must be present, every certificate must be valid at the
 * payload's own `signedDate`, and the signature must verify under the leaf
 * key. This is what Apple's own App Store Server Library does, without its
 * dependency tree (node:crypto alone, so the billing Lambda's cold start is
 * unchanged).
 *
 * Not done: OCSP revocation checks (the library makes them optional and
 * off by default too).
 */

/**
 * Apple Root CA - G3, from https://www.apple.com/certificateauthority/
 * (AppleRootCA-G3.cer). SHA-256 fingerprint
 * 63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79,
 * which matches the copy in macOS's SystemRootCertificates keychain
 * (checked 2026-10-24). Valid until 2039-04-30.
 */
export const APPLE_ROOT_CA_G3_PEM = `-----BEGIN CERTIFICATE-----
MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwS
QXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9u
IEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcN
MTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBS
b290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9y
aXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49
AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtf
TjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517
IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySr
MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gA
MGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4
at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM
6BgD56KyKA==
-----END CERTIFICATE-----
`;

/** Marker extension on Apple's App Store receipt-signing leaf certificate. */
export const APPLE_LEAF_MARKER_OID = '1.2.840.113635.100.6.11.1';
/** Marker extension on the Apple Worldwide Developer Relations intermediate. */
export const APPLE_INTERMEDIATE_MARKER_OID = '1.2.840.113635.100.6.2.1';

export class AppStoreVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppStoreVerificationError';
  }
}

export interface VerifyOptions {
  /** Trusted roots, PEM. Defaults to Apple Root CA - G3. Tests pass their own. */
  trustedRootsPem?: string[];
}

/** DER encoding of an OBJECT IDENTIFIER, to find an extension in a certificate's bytes. */
export function oidToDer(oid: string): Buffer {
  const parts = oid.split('.').map((n) => Number(n));
  const body: number[] = [parts[0] * 40 + parts[1]];
  for (const n of parts.slice(2)) {
    const stack: number[] = [n & 0x7f];
    let v = Math.floor(n / 128);
    while (v > 0) {
      stack.unshift((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    body.push(...stack);
  }
  return Buffer.from([0x06, body.length, ...body]);
}

function hasExtension(cert: X509Certificate, oid: string): boolean {
  return cert.raw.includes(oidToDer(oid));
}

function b64urlJson(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw new AppStoreVerificationError('JWS segment is not base64url JSON');
  }
}

function validAt(cert: X509Certificate, at: Date): boolean {
  return Date.parse(cert.validFrom) <= at.getTime() && at.getTime() <= Date.parse(cert.validTo);
}

/**
 * Verify a compact JWS from Apple and return its decoded payload. Throws
 * `AppStoreVerificationError` for anything that is not a well-formed JWS
 * signed through the trusted chain. The caller still checks what the payload
 * says (bundle id, environment, product).
 */
export function verifyAppleJws<T = Record<string, unknown>>(
  jws: string,
  options: VerifyOptions = {}
): T {
  if (typeof jws !== 'string' || jws.length > 64_000) {
    throw new AppStoreVerificationError('JWS missing or too large');
  }
  const segments = jws.split('.');
  if (segments.length !== 3 || segments.some((s) => !s)) {
    throw new AppStoreVerificationError('JWS is not three segments');
  }
  const [headerB64, payloadB64, signatureB64] = segments;
  const header = b64urlJson(headerB64) as { alg?: unknown; x5c?: unknown };
  if (header.alg !== 'ES256') throw new AppStoreVerificationError('JWS alg must be ES256');
  if (
    !Array.isArray(header.x5c) ||
    header.x5c.length !== 3 ||
    !header.x5c.every((c) => typeof c === 'string')
  ) {
    throw new AppStoreVerificationError('JWS x5c must carry three certificates');
  }

  let leaf: X509Certificate;
  let intermediate: X509Certificate;
  let root: X509Certificate;
  try {
    [leaf, intermediate, root] = header.x5c.map(
      (c) => new X509Certificate(Buffer.from(c, 'base64'))
    );
  } catch {
    throw new AppStoreVerificationError('JWS x5c certificate does not parse');
  }

  const trusted = (options.trustedRootsPem ?? [APPLE_ROOT_CA_G3_PEM]).map(
    (pem) => new X509Certificate(pem)
  );
  if (!trusted.some((t) => t.raw.equals(root.raw))) {
    throw new AppStoreVerificationError('JWS chain does not end at a trusted root');
  }
  if (!intermediate.checkIssued(root) || !intermediate.verify(root.publicKey)) {
    throw new AppStoreVerificationError('JWS intermediate is not signed by the root');
  }
  if (!leaf.checkIssued(intermediate) || !leaf.verify(intermediate.publicKey)) {
    throw new AppStoreVerificationError('JWS leaf is not signed by the intermediate');
  }
  if (!intermediate.ca) throw new AppStoreVerificationError('JWS intermediate is not a CA');
  if (!hasExtension(intermediate, APPLE_INTERMEDIATE_MARKER_OID)) {
    throw new AppStoreVerificationError('JWS intermediate lacks the Apple marker extension');
  }
  if (!hasExtension(leaf, APPLE_LEAF_MARKER_OID)) {
    throw new AppStoreVerificationError('JWS leaf lacks the Apple marker extension');
  }

  const signed = Buffer.from(`${headerB64}.${payloadB64}`, 'ascii');
  const signature = Buffer.from(signatureB64, 'base64url');
  const ok = (() => {
    try {
      return verifySignature(
        'sha256',
        signed,
        { key: leaf.publicKey, dsaEncoding: 'ieee-p1363' },
        signature
      );
    } catch {
      return false;
    }
  })();
  if (!ok) throw new AppStoreVerificationError('JWS signature does not verify');

  const payload = b64urlJson(payloadB64) as Record<string, unknown>;
  // Apple's library checks the chain at the payload's signing time, so a
  // notification retried after a certificate rotation still verifies. The
  // signature is already proven, so the date is Apple's, not the caller's.
  const signedDate =
    typeof payload.signedDate === 'number' ? new Date(payload.signedDate) : new Date();
  if (![leaf, intermediate, root].every((c) => validAt(c, signedDate))) {
    throw new AppStoreVerificationError('JWS certificate not valid at signedDate');
  }
  return payload as T;
}
