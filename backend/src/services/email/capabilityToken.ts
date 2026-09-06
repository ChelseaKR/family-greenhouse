/**
 * The email capability TOKEN CODEC: mint, parse, verify. Pure — no DynamoDB,
 * no AWS SDK, no environment.
 *
 * Split from `capability.ts` (which owns the stored per-user secret) for one
 * concrete reason: `local-server.ts` mirrors the unsubscribe flow with an
 * in-memory secret store, and importing the storage module dragged
 * `utils/dynamodb.ts` — and its module-scope `requireEnv('TABLE_NAME')` —
 * into the dev server's import graph, taking it down at startup before it
 * could answer /health. `tests/integration/local-server-boot.test.ts` guards
 * exactly that. Keeping the codec pure means the dev server and the Lambda
 * verify tokens with the same code and neither pays for the other's
 * dependencies.
 *
 * Shape:
 *
 *   v1.<userId>.<category>.<expiryEpochSeconds>.<hmac>
 *
 * all base64url, the HMAC over the first four fields.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Email categories a recipient can switch off without logging in.
 *  Transactional mail (welcome, password, billing) is deliberately absent:
 *  it keeps its own path and is not unsubscribable. */
export const EMAIL_CATEGORIES = ['weekly_digest', 'year_recap', 'pest_alerts'] as const;
export type EmailCategory = (typeof EMAIL_CATEGORIES)[number];

export function isEmailCategory(value: unknown): value is EmailCategory {
  return typeof value === 'string' && (EMAIL_CATEGORIES as readonly string[]).includes(value);
}

export type VerifyResult =
  | { status: 'ok'; userId: string; category: EmailCategory }
  | { status: 'invalid' }
  | { status: 'expired' }
  | { status: 'unavailable' };

const b64 = (value: string): string => Buffer.from(value, 'utf8').toString('base64url');
const unb64 = (value: string): string => Buffer.from(value, 'base64url').toString('utf8');

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function signToken(
  secret: string,
  userId: string,
  category: EmailCategory,
  expiresAtEpoch: number
): string {
  const payload = `v1.${b64(userId)}.${b64(category)}.${expiresAtEpoch}`;
  return `${payload}.${sign(secret, payload)}`;
}

/** Parsed token fields, before the signature is checked. */
export interface ParsedToken {
  userId: string;
  category: EmailCategory;
  expiresAt: number;
  mac: string;
}

export function parseToken(token: string): ParsedToken | null {
  const parts = token.split('.');
  if (parts.length !== 5 || parts[0] !== 'v1') return null;
  const [, encodedUser, encodedCategory, encodedExpiry, mac] = parts;
  let userId: string;
  let category: string;
  try {
    userId = unb64(encodedUser);
    category = unb64(encodedCategory);
  } catch {
    return null;
  }
  if (!userId || !isEmailCategory(category)) return null;
  const expiresAt = Number.parseInt(encodedExpiry, 10);
  if (!Number.isFinite(expiresAt)) return null;
  return { userId, category, expiresAt, mac };
}

/**
 * Verify against a known secret.
 *
 * The signature is checked BEFORE expiry so an unsigned guess cannot learn
 * from the response whether it named a real user.
 */
export function verifyTokenWithSecret(
  token: string,
  secret: string,
  now: Date = new Date()
): VerifyResult {
  const parsed = parseToken(token);
  if (!parsed) return { status: 'invalid' };
  const expected = signToken(secret, parsed.userId, parsed.category, parsed.expiresAt).split(
    '.'
  )[4];
  const a = Buffer.from(expected);
  const b = Buffer.from(parsed.mac);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { status: 'invalid' };
  if (parsed.expiresAt * 1000 <= now.getTime()) return { status: 'expired' };
  return { status: 'ok', userId: parsed.userId, category: parsed.category };
}
