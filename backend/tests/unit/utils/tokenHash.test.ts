/**
 * utils/tokenHash.ts is the at-rest hash for every bearer credential (#450).
 *
 * Two things are pinned here by VALUE, not by property, because a property
 * ("deterministic", "64 hex chars", "differs per salt") holds for any salt and
 * any key length — and changing either silently strands every live credential
 * of that kind:
 *   1. one digest per surface, computed from the construction each service
 *      used before it was lifted into the shared helper;
 *   2. the legacy-fallback guard, against the exact attack it exists for.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  TOKEN_HASH_SALTS,
  hashCapabilityToken,
  readTokenRow,
  type TokenHashSurface,
} from '../../../src/utils/tokenHash.js';

const INPUT = '0123456789abcdef'.repeat(4);

/**
 * Literal digests of INPUT under each surface's salt, computed with
 * `scryptSync(INPUT, salt, 32).toString('hex')` — the one-line body every
 * service had before this helper existed (apiKeys.hashKey, calendarTokens,
 * sitter, kiosk, caretaker, giftSubscriptions.hashGiftCode). If one of these
 * moves, every live credential of that surface stops resolving.
 *
 * (A list of { surface, digest } rather than a map keyed by surface: a
 * 64-hex literal right after a key named `apiKey:` reads to the secret
 * scanner as exactly what it is shaped like. These are digests of a fixed
 * test input, not credentials.)
 */
const GOLDEN: ReadonlyArray<{ surface: TokenHashSurface; digest: string }> = [
  { surface: 'apiKey', digest: '599ad6a63645da345a395db1e19a9e50e1280a84796d23a364dc7c5b8ccf6ec7' },
  {
    surface: 'calendarToken',
    digest: '60d74933c3c25c898ee83fab92ca4edb5224e814c67f4da8c6c791986ce9e8c4',
  },
  {
    surface: 'sitterLink',
    digest: '9f4984912e841215d7b66f2d33f05ceab212b2f6fed8504c23752333f1d49094',
  },
  {
    surface: 'kioskLink',
    digest: '5709e0a7c4d7d62acb2b21f108bafa8fd67566b4358de2acfbf4c639fe1f60e7',
  },
  {
    surface: 'caretakerSeat',
    digest: 'be5546f300e1caa06950e84f60170b8f4245ea9ac58d88f9dd3dd2c45b946f25',
  },
  {
    surface: 'giftCode',
    digest: '08dcd8f76567b2e395c89ccc2584bfba8419468b580756c7e51322ca4b83c318',
  },
  {
    surface: 'plantTag',
    digest: 'b1448351a283d5d676b28595b9cea1205dca4cce2e6a0d77fe757391188939ef',
  },
  {
    surface: 'plantShare',
    digest: '09c0552fc6045764394e1572481873b1c04c5e444395b024a06fa0a6e463bdbd',
  },
  {
    surface: 'emailReply',
    digest: '794a8be3e85c12e8f8e8d07fb31f9af0d61b32d7c976229af0900918ddbdca52',
  },
];

describe('hashCapabilityToken', () => {
  it.each(GOLDEN)(
    'produces the pinned digest for $surface (a change strands every live credential)',
    ({ surface, digest }) => {
      expect(hashCapabilityToken(surface, INPUT)).toBe(digest);
    }
  );

  it('covers every surface in the salt table — none added without a pinned digest', () => {
    expect(Object.keys(TOKEN_HASH_SALTS).sort()).toEqual(GOLDEN.map((g) => g.surface).sort());
  });

  it('gives every surface its own salt, so a token cannot resolve on another surface', () => {
    const salts = Object.values(TOKEN_HASH_SALTS);
    expect(new Set(salts).size).toBe(salts.length);
    const digests = GOLDEN.map((g) => g.digest);
    expect(new Set(digests).size).toBe(digests.length);
  });
});

// ---------------------------------------------------------------------------
// readTokenRow — the dual read, and the guard on its legacy half
// ---------------------------------------------------------------------------

const TOKEN = 'a'.repeat(64);
const DIGEST = hashCapabilityToken('plantTag', TOKEN);
const pk = (suffix: string) => `PLANTTAG#${suffix}`;

/** A tiny table keyed by PK, and a read that records every key it was asked for. */
function table(rows: Record<string, Record<string, unknown>>) {
  const reads: string[] = [];
  const read = vi.fn(async (key: string) => {
    reads.push(key);
    return rows[key] ?? null;
  });
  return { read, reads };
}

/** What a table export yields for a hashed tag: a digest-keyed row, no token. */
const hashedRow = { PK: pk(DIGEST), SK: 'METADATA', tokenHash: DIGEST, id: 'tag-new' };
/** A pre-#450 row: keyed by its plaintext, and carrying it. */
const legacyRow = { PK: pk(TOKEN), SK: 'METADATA', token: TOKEN, id: 'tag-legacy' };

/**
 * The fallback as #551/#569 shipped it for sitter, kiosk and caretaker rows:
 * `read(hashed) ?? read(plaintext)`, with no check on what the second read
 * found. Reproduced here ONLY as a negative control.
 */
async function naiveDualRead(token: string, read: (key: string) => Promise<unknown>) {
  return (await read(pk(hashCapabilityToken('plantTag', token)))) ?? (await read(pk(token)));
}

describe('readTokenRow', () => {
  it('reads the hashed key first and stops there when it hits', async () => {
    const { read, reads } = table({ [pk(DIGEST)]: hashedRow });
    const row = await readTokenRow({ surface: 'plantTag', token: TOKEN, pk, read });
    expect(row?.id).toBe('tag-new');
    expect(reads).toEqual([pk(DIGEST)]);
  });

  it('falls back to ONE point read on the plaintext key for a pre-hash row', async () => {
    const { read, reads } = table({ [pk(TOKEN)]: legacyRow });
    const row = await readTokenRow({ surface: 'plantTag', token: TOKEN, pk, read });
    expect(row?.id).toBe('tag-legacy');
    expect(reads).toEqual([pk(DIGEST), pk(TOKEN)]);
  });

  it('answers null when neither generation has the row', async () => {
    const { read } = table({});
    expect(await readTokenRow({ surface: 'plantTag', token: TOKEN, pk, read })).toBeNull();
  });

  it('REFUSES a digest lifted from a table export, presented as if it were the token', async () => {
    // The attack: the digest is 64 lowercase hex, so it passes every token
    // shape gate, and `{PREFIX}#{digest}` is the hashed row's real key.
    const { read } = table({ [pk(DIGEST)]: hashedRow });
    expect(DIGEST).toMatch(/^[0-9a-f]{64}$/);
    expect(await readTokenRow({ surface: 'plantTag', token: DIGEST, pk, read })).toBeNull();
  });

  it('negative control: the unguarded fallback DOES hand the dump’s digest a live row', async () => {
    // Proves the fixture above is a real attack rather than a row the guard
    // never had to reject: the same table, the same presented digest, the
    // pre-fix read — and the hashed row comes back.
    const { read } = table({ [pk(DIGEST)]: hashedRow });
    const leaked = (await naiveDualRead(DIGEST, read)) as { id?: string } | null;
    expect(leaked?.id).toBe('tag-new');
  });

  it('refuses a legacy-keyed row whose stored plaintext is not the presented token', async () => {
    const { read } = table({ [pk(TOKEN)]: { ...legacyRow, token: 'b'.repeat(64) } });
    expect(await readTokenRow({ surface: 'plantTag', token: TOKEN, pk, read })).toBeNull();
  });

  it('checks the attribute a surface actually stored its plaintext in (shares: `code`)', async () => {
    const code = 'c'.repeat(32);
    const sharePk = (suffix: string) => `SHARE#${suffix}`;
    const { read } = table({ [sharePk(code)]: { PK: sharePk(code), code } });
    const row = await readTokenRow({
      surface: 'plantShare',
      token: code,
      pk: sharePk,
      read,
      plaintextAttribute: 'code',
    });
    expect(row?.code).toBe(code);
    // …and the default attribute does not find it, so the option is load-bearing.
    expect(
      await readTokenRow({ surface: 'plantShare', token: code, pk: sharePk, read })
    ).toBeNull();
  });
});
