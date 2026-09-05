import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scryptSync } from 'node:crypto';

/** The production hash, restated here so a silent change to the salt or the
 *  KDF fails a test rather than quietly stranding every live link. */
function expectedHash(token: string): string {
  return scryptSync(token, 'family-greenhouse-sitter-v1', 32).toString('hex');
}

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  PutCommand: vi.fn(function (input) {
    return { input, kind: 'Put' };
  }),
  GetCommand: vi.fn(function (input) {
    return { input, kind: 'Get' };
  }),
  QueryCommand: vi.fn(function (input) {
    return { input, kind: 'Query' };
  }),
  UpdateCommand: vi.fn(function (input) {
    return { input, kind: 'Update' };
  }),
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));

async function load() {
  const { dynamodb } = await import('../../../src/utils/dynamodb.js');
  const svc = await import('../../../src/services/sitterService.js');
  return { dynamodb, svc };
}

const HH = 'hh-1';

function activeRow(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    Item: {
      id: 'link-1',
      token: 'a'.repeat(64),
      householdId: HH,
      createdBy: 'u1',
      createdAt: new Date(now - 1000).toISOString(),
      startsAt: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      status: 'active',
      label: 'Our plants',
      ...overrides,
    },
  };
}

describe('sitterService.createSitterLink', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mints a 256-bit hex token and writes the row with a TTL + GSI1 key', async () => {
    const { dynamodb, svc } = await load();
    vi.mocked(dynamodb.send).mockResolvedValueOnce({} as never);

    const link = await svc.createSitterLink({
      householdId: HH,
      createdBy: 'u1',
      startsAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      label: 'Our plants',
    });

    // 256 bits = 64 hex chars, from the OS CSPRNG.
    expect(link.token).toMatch(/^[0-9a-f]{64}$/);

    const cmd = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      input: { Item: Record<string, unknown> };
    };
    // #450: the row is keyed by the token's hash, and the plaintext is on no
    // attribute of it — a table export yields nothing that opens the link.
    expect(cmd.input.Item.PK).toBe(`SITTER#${expectedHash(link.token)}`);
    expect(cmd.input.Item.PK).not.toBe(`SITTER#${link.token}`);
    expect(cmd.input.Item.tokenHash).toBe(expectedHash(link.token));
    expect(Object.values(cmd.input.Item)).not.toContain(link.token);
    expect(cmd.input.Item.token).toBeUndefined();
    expect(cmd.input.Item.entityType).toBe('SitterLink');
    expect(cmd.input.Item.GSI1PK).toBe(`HOUSEHOLD#${HH}#SITTER`);
    expect(typeof cmd.input.Item.ttl).toBe('number');
  });

  it('mints a fresh, unique token each call (no reuse)', async () => {
    const { dynamodb, svc } = await load();
    vi.mocked(dynamodb.send).mockResolvedValue({} as never);
    const a = await svc.createSitterLink({
      householdId: HH,
      createdBy: 'u1',
      startsAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      label: null,
    });
    const b = await svc.createSitterLink({
      householdId: HH,
      createdBy: 'u1',
      startsAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      label: null,
    });
    expect(a.token).not.toBe(b.token);
  });
});

describe('sitterService.getActiveLink', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the link for an active, in-window token', async () => {
    const { dynamodb, svc } = await load();
    vi.mocked(dynamodb.send).mockResolvedValueOnce(activeRow() as never);
    const link = await svc.getActiveLink('a'.repeat(64));
    expect(link?.householdId).toBe(HH);
  });

  it('rejects a malformed token WITHOUT hitting DynamoDB (no oracle, no read cost)', async () => {
    const { dynamodb, svc } = await load();
    const link = await svc.getActiveLink('not-hex');
    expect(link).toBeNull();
    expect(dynamodb.send).not.toHaveBeenCalled();
  });

  it('returns null for a missing row', async () => {
    const { dynamodb, svc } = await load();
    // Both reads miss: the hashed key and the legacy plaintext key.
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({} as never)
      .mockResolvedValueOnce({} as never);
    expect(await svc.getActiveLink('a'.repeat(64))).toBeNull();
  });

  it('returns null for a revoked link', async () => {
    const { dynamodb, svc } = await load();
    vi.mocked(dynamodb.send).mockResolvedValueOnce(activeRow({ status: 'revoked' }) as never);
    expect(await svc.getActiveLink('a'.repeat(64))).toBeNull();
  });

  it('returns null for an expired link (defence in depth past the TTL sweep)', async () => {
    const { dynamodb, svc } = await load();
    vi.mocked(dynamodb.send).mockResolvedValueOnce(
      activeRow({ expiresAt: new Date(Date.now() - 1000).toISOString() }) as never
    );
    expect(await svc.getActiveLink('a'.repeat(64))).toBeNull();
  });

  it('returns null before the window starts', async () => {
    const { dynamodb, svc } = await load();
    vi.mocked(dynamodb.send).mockResolvedValueOnce(
      activeRow({ startsAt: new Date(Date.now() + 60_000).toISOString() }) as never
    );
    expect(await svc.getActiveLink('a'.repeat(64))).toBeNull();
  });
});

describe('sitterService.toSummary', () => {
  it('strips the secret token from the management view', async () => {
    const { svc } = await load();
    const summary = svc.toSummary({
      id: 'l1',
      token: 'a'.repeat(64),
      keyToken: expectedHash('a'.repeat(64)),
      householdId: HH,
      createdBy: 'u1',
      createdAt: 'now',
      startsAt: 'now',
      expiresAt: 'later',
      status: 'active',
      label: null,
    });
    expect((summary as Record<string, unknown>).token).toBeUndefined();
    // keyToken is the row's partition key — for a legacy row it IS the secret,
    // so the management view must not carry it either.
    expect((summary as Record<string, unknown>).keyToken).toBeUndefined();
    expect(summary.id).toBe('l1');
  });
});

describe('sitterService.revokeSitterLink', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns false when the id is not in the household (no cross-household revoke)', async () => {
    const { dynamodb, svc } = await load();
    // listSitterLinks query returns one link with a different id.
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Items: [activeRow().Item] } as never);
    const ok = await svc.revokeSitterLink(HH, 'some-other-id');
    expect(ok).toBe(false);
  });

  it('flips status to revoked for a matching id', async () => {
    const { dynamodb, svc } = await load();
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({ Items: [activeRow().Item] } as never) // list
      .mockResolvedValueOnce({} as never); // update
    const ok = await svc.revokeSitterLink(HH, 'link-1');
    expect(ok).toBe(true);
    const update = vi.mocked(dynamodb.send).mock.calls[1][0] as unknown as {
      input: { ExpressionAttributeValues: Record<string, unknown> };
    };
    expect(update.input.ExpressionAttributeValues[':revoked']).toBe('revoked');
  });
});

// #449: a sitter link grants the whole household's task list plus completion
// and photo upload, and its holder is whoever the departing member handed it
// to. Expiry bounds it; it does not end it today.
describe('sitterService.revokeSitterLinksCreatedBy', () => {
  beforeEach(() => vi.clearAllMocks());

  function row(overrides: Record<string, unknown> = {}) {
    const now = Date.now();
    return {
      id: 'link-1',
      token: 'a'.repeat(64),
      householdId: HH,
      createdBy: 'departing',
      createdAt: new Date(now - 1000).toISOString(),
      startsAt: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      status: 'active',
      label: null,
      ...overrides,
    };
  }

  it('revokes only the departing member’s active links', async () => {
    const { dynamodb, svc } = await load();
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({
        Items: [
          row(),
          row({ id: 'link-2', token: 'b'.repeat(64), createdBy: 'staying' }),
          row({ id: 'link-3', token: 'c'.repeat(64), status: 'revoked' }),
        ],
      } as never)
      .mockResolvedValueOnce({} as never);

    expect(await svc.revokeSitterLinksCreatedBy(HH, 'departing')).toBe(1);
    const writes = vi
      .mocked(dynamodb.send)
      .mock.calls.map((c) => c[0] as unknown as { kind: string; input: { Key?: { PK: string } } })
      .filter((c) => c.kind === 'Update');
    expect(writes).toHaveLength(1);
    expect(writes[0].input.Key?.PK).toBe(`SITTER#${'a'.repeat(64)}`);
  });

  it('THROWS on a failed read rather than reporting 0 revoked', async () => {
    const { dynamodb, svc } = await load();
    vi.mocked(dynamodb.send).mockRejectedValueOnce(new Error('dynamo down') as never);
    await expect(svc.revokeSitterLinksCreatedBy(HH, 'departing')).rejects.toThrow('dynamo down');
  });
});

/**
 * A single-page `Limit` is not a failed read — nothing throws, nothing is
 * caught — so it slipped past both halves of the settled-read gate while
 * publishing a partial list as the household's whole list. Every revocation
 * path reads through `listSitterLinks`. (#455 / #457 gap 2)
 */
describe('sitterService — the link list is the whole link list', () => {
  // mockReset, not clearAllMocks: a queued mockResolvedValueOnce that a
  // previous test never consumed would otherwise answer the first query here.
  beforeEach(async () => {
    const { dynamodb } = await load();
    vi.mocked(dynamodb.send).mockReset();
  });

  it('follows LastEvaluatedKey and resumes where the first page stopped', async () => {
    const { dynamodb, svc } = await load();
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({
        Items: [activeRow({ id: 'link-new' }).Item],
        LastEvaluatedKey: { PK: 'SITTER#new' },
      } as never)
      .mockResolvedValueOnce({ Items: [activeRow({ id: 'link-old' }).Item] } as never);

    const links = await svc.listSitterLinks(HH);
    expect(links.map((l) => l.id)).toEqual(['link-new', 'link-old']);
    const second = vi.mocked(dynamodb.send).mock.calls[1][0] as unknown as {
      input: { ExclusiveStartKey?: Record<string, unknown> };
    };
    expect(second.input.ExclusiveStartKey).toEqual({ PK: 'SITTER#new' });
  });

  it('revokes a link that lives past the first page instead of answering 404', async () => {
    const { dynamodb, svc } = await load();
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({
        Items: [activeRow({ id: 'link-new', token: 'n'.repeat(64) }).Item],
        LastEvaluatedKey: { PK: 'SITTER#new' },
      } as never)
      .mockResolvedValueOnce({
        Items: [activeRow({ id: 'link-old', token: 'o'.repeat(64) }).Item],
      } as never)
      .mockResolvedValueOnce({} as never);

    expect(await svc.revokeSitterLink(HH, 'link-old')).toBe(true);
    const writes = vi
      .mocked(dynamodb.send)
      .mock.calls.map((c) => c[0] as unknown as { kind: string; input: { Key?: { PK: string } } })
      .filter((c) => c.kind === 'Update');
    expect(writes).toHaveLength(1);
    expect(writes[0].input.Key?.PK).toBe(`SITTER#${'o'.repeat(64)}`);
  });
});

/**
 * #450: a sitter link grants a whole household's task list, completion and
 * photo upload, and it used to be stored as `PK: SITTER#{plaintext}`. Any
 * table export, point-in-time restore, or principal with `dynamodb:Scan` came
 * away with live, working links — while the calendar token and the API key in
 * the same dump came away as scrypt digests. This is that inconsistency
 * closed, plus the migration it needs: a link already in somebody's messages
 * must keep working.
 */
describe('sitterService — the token is not in the table (#450)', () => {
  beforeEach(async () => {
    const { dynamodb } = await load();
    vi.mocked(dynamodb.send).mockReset();
  });

  it('resolves a link written by createSitterLink (hash written, hash read)', async () => {
    const { dynamodb, svc } = await load();
    vi.mocked(dynamodb.send).mockResolvedValueOnce({} as never);
    const minted = await svc.createSitterLink({
      householdId: HH,
      createdBy: 'u1',
      startsAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      label: null,
    });
    const written = (
      vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
        input: { Item: Record<string, unknown> };
      }
    ).input.Item;

    // Hand the stored row straight back to the read path, keyed the way the
    // write path keyed it. A round trip is the only assertion that catches a
    // write/read hash mismatch, which would strand every link ever minted.
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: written } as never);
    const resolved = await svc.getActiveLink(minted.token);
    expect(resolved?.id).toBe(minted.id);

    const get = vi.mocked(dynamodb.send).mock.calls[1][0] as unknown as {
      input: { Key: { PK: string } };
    };
    expect(get.input.Key.PK).toBe(written.PK);
    expect(get.input.Key.PK).toBe(`SITTER#${expectedHash(minted.token)}`);
  });

  it('reads the hashed row FIRST, without touching the plaintext key', async () => {
    const { dynamodb, svc } = await load();
    const token = 'a'.repeat(64);
    vi.mocked(dynamodb.send).mockResolvedValueOnce(
      activeRow({ token: undefined, tokenHash: expectedHash(token) }) as never
    );

    expect((await svc.getActiveLink(token))?.householdId).toBe(HH);
    expect(dynamodb.send).toHaveBeenCalledTimes(1);
    const get = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      input: { Key: { PK: string } };
    };
    expect(get.input.Key.PK).toBe(`SITTER#${expectedHash(token)}`);
  });

  it('still resolves a pre-#450 plaintext-keyed row (a live link does not break)', async () => {
    const { dynamodb, svc } = await load();
    const token = 'a'.repeat(64);
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({} as never) // hashed key: no such row
      .mockResolvedValueOnce(activeRow({ token }) as never); // legacy plaintext row

    expect((await svc.getActiveLink(token))?.householdId).toBe(HH);
    const legacyGet = vi.mocked(dynamodb.send).mock.calls[1][0] as unknown as {
      input: { Key: { PK: string } };
    };
    expect(legacyGet.input.Key.PK).toBe(`SITTER#${token}`);
  });

  it('revokes a hashed row by its hash, not by a token it no longer stores', async () => {
    const { dynamodb, svc } = await load();
    const hash = expectedHash('a'.repeat(64));
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({
        Items: [activeRow({ token: undefined, tokenHash: hash }).Item],
      } as never)
      .mockResolvedValueOnce({} as never);

    expect(await svc.revokeSitterLink(HH, 'link-1')).toBe(true);
    const writes = vi
      .mocked(dynamodb.send)
      .mock.calls.map((c) => c[0] as unknown as { kind: string; input: { Key?: { PK: string } } })
      .filter((c) => c.kind === 'Update');
    expect(writes).toHaveLength(1);
    expect(writes[0].input.Key?.PK).toBe(`SITTER#${hash}`);
  });

  it('revokes a legacy plaintext row by its plaintext key (mixed generations)', async () => {
    const { dynamodb, svc } = await load();
    const hash = expectedHash('n'.repeat(64));
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({
        Items: [
          activeRow({ id: 'link-new', token: undefined, tokenHash: hash }).Item,
          activeRow({ id: 'link-legacy', token: 'z'.repeat(64) }).Item,
        ],
      } as never)
      .mockResolvedValueOnce({} as never);

    expect(await svc.revokeSitterLink(HH, 'link-legacy')).toBe(true);
    const writes = vi
      .mocked(dynamodb.send)
      .mock.calls.map((c) => c[0] as unknown as { kind: string; input: { Key?: { PK: string } } })
      .filter((c) => c.kind === 'Update');
    expect(writes[0].input.Key?.PK).toBe(`SITTER#${'z'.repeat(64)}`);
  });

  it('a listed link carries no plaintext token for the handler to leak', async () => {
    const { dynamodb, svc } = await load();
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Items: [activeRow({ token: undefined, tokenHash: expectedHash('a'.repeat(64)) }).Item],
    } as never);
    const links = await svc.listSitterLinks(HH);
    expect(links).toHaveLength(1);
    expect(links[0].token).toBeNull();
    expect(links[0].keyToken).toBe(expectedHash('a'.repeat(64)));
  });
});
