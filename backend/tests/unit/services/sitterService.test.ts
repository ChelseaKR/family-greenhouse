import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    expect(cmd.input.Item.PK).toBe(`SITTER#${link.token}`);
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
    vi.mocked(dynamodb.send).mockResolvedValueOnce({} as never);
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
      householdId: HH,
      createdBy: 'u1',
      createdAt: 'now',
      startsAt: 'now',
      expiresAt: 'later',
      status: 'active',
      label: null,
    });
    expect((summary as Record<string, unknown>).token).toBeUndefined();
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
