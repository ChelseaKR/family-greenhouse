/**
 * TOTP for the two-step-verification e2e (#671). Test-only: production never
 * computes a code — Cognito checks them — and nothing here ships in a bundle.
 *
 * FIXED_TOTP_SECRET is the secret the local mock backend hands out when the
 * Playwright webServer starts it with `E2E_TOTP_SECRET_SEED=<the seed below>`
 * (see playwright.config.ts): the base32 form of a readable phrase, never a
 * key-shaped literal. The mock honours that pin only alongside the
 * test-fixture opt-in, so no hand-started dev server, and no deployed
 * environment, ever issues it.
 */
import { createHmac } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Must match E2E_TOTP_SECRET_SEED in playwright.config.ts. 20 bytes, like Cognito's. */
export const TOTP_SECRET_SEED = 'TestSecretTestSecret';

/** The pinned secret, derived rather than written out: obviously not a credential. */
export const FIXED_TOTP_SECRET = base32Encode(Buffer.from(TOTP_SECRET_SEED));

function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text.replace(/[\s=]/g, '').toUpperCase()) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`not base32: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 6238, SHA-1, 6 digits, 30-second steps — what authenticator apps do. */
export function totpCode(secret: string, atMs = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 30_000)));
  const digest = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(binary % 1_000_000).padStart(6, '0');
}

/** Every code the server would accept right now (one step of skew either side). */
export function acceptedCodes(secret: string, atMs = Date.now()): Set<string> {
  return new Set([-1, 0, 1].map((step) => totpCode(secret, atMs + step * 30_000)));
}

/** A six-digit code that is NOT accepted right now — the negative control. */
export function rejectedCode(secret: string, atMs = Date.now()): string {
  const accepted = acceptedCodes(secret, atMs);
  for (let n = 0; ; n++) {
    const candidate = String(n).padStart(6, '0');
    if (!accepted.has(candidate)) return candidate;
  }
}
