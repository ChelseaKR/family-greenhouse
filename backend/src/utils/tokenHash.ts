/**
 * The ONE at-rest hash for every bearer credential this system mints.
 *
 * API keys, calendar-feed tokens, sitter links, kiosk links, caretaker seats
 * and gift codes each grew their own one-line copy of the same construction —
 * `scryptSync(token, '<fixed salt>', 32).toString('hex')` — and plant tags and
 * cutting shares were left out of it entirely (#450). This module is that
 * construction, lifted out unchanged so a credential added later reuses it
 * rather than inventing a second scheme, and so the salts sit in one table
 * where "every surface's salt is different" is checkable instead of a
 * convention restated in six comments.
 *
 * Why this construction, stated once (it used to be stated per module):
 *
 *   - DETERMINISTIC, because the digest is the lookup key. A presented token is
 *     hashed and resolved with one point read (`GetItem` on the partition key,
 *     or a query on a hash-keyed GSI). A per-row random salt (bcrypt/argon2)
 *     would make that impossible.
 *   - A FIXED salt costs nothing here, because every input is a CSPRNG value of
 *     at least 128 bits, not a human-chosen password: there is no dictionary to
 *     precompute against.
 *   - scrypt rather than SHA-256 because the repo's `js/insufficient-password-
 *     hash` policy rejects an unsalted digest, and memory-hardness is free at
 *     this scale (N=16384 default, ~10-50 ms per call).
 *   - A DIFFERENT salt per surface, so a token minted for one surface can never
 *     resolve on another even if it is pasted there, and a digest from one
 *     table partition says nothing about another.
 *
 * Changing ANY of this — the salt strings, the key length, the cost, the hex
 * encoding — silently strands every live credential of that kind: sitter links
 * in people's messages, API keys in scripts, calendar feeds in phones, and
 * printed plant tags in pots. `tests/unit/utils/tokenHash.test.ts` pins a
 * digest per salt for exactly that reason.
 */
import { scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * One salt per credential surface. The `-vN` suffix is part of the salt, not
 * metadata: bumping it IS a migration (every existing digest stops matching).
 */
export const TOKEN_HASH_SALTS = {
  apiKey: 'family-greenhouse-apikey-v2',
  calendarToken: 'family-greenhouse-caltoken-v1',
  sitterLink: 'family-greenhouse-sitter-v1',
  kioskLink: 'family-greenhouse-kiosk-v1',
  caretakerSeat: 'family-greenhouse-caretaker-v1',
  giftCode: 'family-greenhouse-giftcode-v1',
  plantTag: 'family-greenhouse-planttag-v1',
  plantShare: 'family-greenhouse-plantshare-v1',
  /** The per-message reply address on a reminder email (#667). */
  emailReply: 'family-greenhouse-emailreply-v1',
} as const;

export type TokenHashSurface = keyof typeof TOKEN_HASH_SALTS;

/** Digest length in bytes; the hex digest is twice this. */
const DIGEST_BYTES = 32;

/**
 * Deterministic, memory-hard digest of a bearer credential for the given
 * surface — 64 lowercase hex chars. Use it as (part of) the lookup key and
 * store nothing else that could reconstruct the credential.
 */
export function hashCapabilityToken(surface: TokenHashSurface, token: string): string {
  return scryptSync(token, TOKEN_HASH_SALTS[surface], DIGEST_BYTES).toString('hex');
}

/**
 * Constant-time equality for two credential strings. `!==` returns at the
 * first differing byte; this does not, so the time to refuse a near-miss says
 * nothing about how near it was. Unequal lengths are refused up front (a token
 * of the wrong length never reaches here through a shape gate, and the length
 * of a credential is not a secret).
 */
export function tokensMatch(stored: unknown, presented: string): boolean {
  if (typeof stored !== 'string') return false;
  const a = Buffer.from(stored);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * What an `upgrade` hook reports for a legacy row it tried to move to its
 * hashed key: the hashed row it wrote (`Record`), `'raced'` when a live request
 * changed or removed the row first, or `null` when the move could not be
 * attempted at all (a write error; the request still has to be served).
 */
export type LegacyUpgradeResult = Record<string, unknown> | 'raced' | null;

/**
 * Resolve a presented token to its row across both generations of a surface
 * that used to key rows by the plaintext token: the hashed key first, then ONE
 * point read on the legacy plaintext key, so a credential minted before the
 * surface was hashed (a sitter link in someone's messages, a wall display, a
 * printed plant tag) keeps working.
 *
 * The legacy read is only honoured when the row it finds still CARRIES the
 * presented token as its plaintext attribute. That check is the whole point
 * of hashing, not a nicety: a hashed row's partition key is
 * `{PREFIX}#{digest}`, and a digest is 64 lowercase hex characters — exactly
 * the shape of a token. Without the check, the fallback read of
 * `{PREFIX}#{presented}` resolves a digest lifted from a table export straight
 * to its live row, and the dump yields working credentials again. Every
 * legacy row wrote its token as an attribute (the records were spread onto the
 * item), and no hashed row carries one, so the check separates the two
 * generations exactly. The comparison is constant-time.
 *
 * A legacy hit is UPGRADED when the caller supplies `upgrade`: the row is
 * moved to its hashed key in one atomic write (see `upgradeLegacyRow` in
 * `services/tokenHashBackfill.ts`), so a credential that is still being used
 * stops sitting in plaintext at rest the first time it is used, instead of
 * waiting for an operator to run the backfill. The token the person holds does
 * not change. What this returns is the row the CALLER should keep using:
 *   - moved: the hashed row, because every later write in the same request
 *     addresses the row by its own key, and the legacy key no longer exists;
 *   - raced (a revocation, a wrong-PIN count, the backfill or another scan got
 *     there first): whatever the table holds NOW — the hashed row if it is
 *     there, otherwise the legacy row as it stands, otherwise null;
 *   - could not move: the legacy row exactly as before, so a write failure
 *     costs the upgrade and never the request.
 *
 * All reads are `GetItem` on the partition key: no enumeration surface. The
 * only write is the upgrade, and it can only ever REMOVE a plaintext row.
 */
export async function readTokenRow(options: {
  surface: TokenHashSurface;
  token: string;
  /** Builds the partition key from its suffix (a digest or a legacy token). */
  pk: (suffix: string) => string;
  read: (pk: string) => Promise<Record<string, unknown> | null>;
  /** The attribute a legacy row stored its plaintext in. */
  plaintextAttribute?: string;
  /** Moves a legacy row to its hashed key. Omit to leave legacy rows alone. */
  upgrade?: (legacy: Record<string, unknown>) => Promise<LegacyUpgradeResult>;
}): Promise<Record<string, unknown> | null> {
  const { surface, token, pk, read, plaintextAttribute = 'token', upgrade } = options;
  const hashedKey = pk(hashCapabilityToken(surface, token));
  const hashed = await read(hashedKey);
  if (hashed) return hashed;

  const legacyKey = pk(token);
  const legacy = await read(legacyKey);
  if (!legacy || !tokensMatch(legacy[plaintextAttribute], token)) return null;
  if (!upgrade) return legacy;

  const outcome = await upgrade(legacy);
  if (outcome === null) return legacy;
  if (outcome !== 'raced') return outcome;

  const nowHashed = await read(hashedKey);
  if (nowHashed) return nowHashed;
  const stillLegacy = await read(legacyKey);
  return stillLegacy && tokensMatch(stillLegacy[plaintextAttribute], token) ? stillLegacy : null;
}
