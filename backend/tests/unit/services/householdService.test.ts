import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  PutCommand: vi.fn((input) => ({ input, kind: 'Put' })),
  GetCommand: vi.fn((input) => ({ input, kind: 'Get' })),
  QueryCommand: vi.fn((input) => ({ input, kind: 'Query' })),
  DeleteCommand: vi.fn((input) => ({ input, kind: 'Delete' })),
  TransactWriteCommand: vi.fn((input) => ({ input, kind: 'TransactWrite' })),
  UpdateCommand: vi.fn((input) => ({ input, kind: 'Update' })),
}));

vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));

describe('householdService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('createHousehold writes household + member atomically via TransactWrite', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { createHousehold } = await import('../../../src/services/householdService.js');
    vi.mocked(dynamodb.send).mockResolvedValue({});
    const result = await createHousehold({ name: 'Home' }, 'user-1', 'Alice', 'a@b.com');
    expect(result).toMatchObject({ name: 'Home', createdBy: 'user-1' });
    const calls = vi.mocked(dynamodb.send).mock.calls;
    expect(calls).toHaveLength(1);
    const cmd = calls[0][0] as unknown as {
      kind: string;
      input: { TransactItems: Array<{ Put: { Item: Record<string, unknown> } }> };
    };
    expect(cmd.kind).toBe('TransactWrite');
    const items = cmd.input.TransactItems.map((t) => t.Put.Item);
    expect(items).toHaveLength(2);
    const memberItem = items.find((i) => i.entityType === 'HouseholdMember');
    expect(memberItem?.role).toBe('admin');
  });

  it('setMemberRole updates and returns the new role', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { setMemberRole } = await import('../../../src/services/householdService.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Attributes: {
        householdId: 'hh',
        userId: 'u',
        name: 'A',
        email: 'a@b.com',
        role: 'admin',
        joinedAt: '',
      },
    });
    const result = await setMemberRole('hh', 'u', 'admin');
    expect(result?.role).toBe('admin');
  });

  it('setMemberRole returns null when member missing', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { setMemberRole } = await import('../../../src/services/householdService.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Attributes: undefined });
    expect(await setMemberRole('hh', 'u', 'member')).toBeNull();
  });

  it('getHousehold returns null when missing', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { getHousehold } = await import('../../../src/services/householdService.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: undefined });
    expect(await getHousehold('hh')).toBeNull();
  });

  it('getHousehold returns mapped household', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { getHousehold } = await import('../../../src/services/householdService.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Item: { id: 'hh', name: 'Home', createdAt: '2026', createdBy: 'user-1' },
    });
    // The service hydrates `location: null` so the response shape is stable
    // for clients that always expect the field (added with the climate-
    // awareness work).
    expect(await getHousehold('hh')).toEqual({
      id: 'hh',
      name: 'Home',
      location: null,
      createdAt: '2026',
      createdBy: 'user-1',
    });
  });

  it('getHouseholdMembers returns members from query', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { getHouseholdMembers } = await import('../../../src/services/householdService.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Items: [
        {
          householdId: 'hh',
          userId: 'u1',
          name: 'A',
          email: 'a@b.com',
          role: 'admin',
          joinedAt: '2026',
        },
      ],
    });
    const members = await getHouseholdMembers('hh');
    expect(members).toHaveLength(1);
    expect(members[0].role).toBe('admin');
  });

  it('createInvite writes a 128-bit (32-hex-char) code with TTL', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { createInvite } = await import('../../../src/services/householdService.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({});
    const invite = await createInvite('hh', 'user-1');
    // Pre-2026-05-31 this was 12 hex (~48 bits, brute-forceable from a
    // leaked dump). Bumped to a full UUIDv4 hex (128 bits) — the assertion
    // pins both length and hex shape so a future regression won't slip.
    expect(invite.code).toHaveLength(32);
    expect(invite.code).toMatch(/^[0-9a-f]{32}$/);
    const sent = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      input: { Item: Record<string, unknown> };
    };
    expect(sent.input.Item.ttl).toEqual(expect.any(Number));
  });

  it('getInvite returns null for expired invites', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { getInvite } = await import('../../../src/services/householdService.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Item: {
        code: 'X',
        householdId: 'hh',
        createdBy: 'user-1',
        createdAt: '',
        expiresAt: '2000-01-01T00:00:00.000Z',
      },
    });
    expect(await getInvite('X')).toBeNull();
  });

  it('getInvite returns the invite when not expired', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { getInvite } = await import('../../../src/services/householdService.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Item: {
        code: 'X',
        householdId: 'hh',
        createdBy: 'user-1',
        createdAt: '',
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
    });
    const invite = await getInvite('X');
    expect(invite?.code).toBe('X');
  });

  it('addMember defaults to member role', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { addMember } = await import('../../../src/services/householdService.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({});
    const result = await addMember('hh', 'u', 'Name', 'e@x.com');
    expect(result.role).toBe('member');
  });

  it('removeMember sends a DeleteCommand', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { removeMember } = await import('../../../src/services/householdService.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({});
    await removeMember('hh', 'u');
    const cmd = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as { kind: string };
    expect(cmd.kind).toBe('Delete');
  });

  it('getMemberByUserId returns null when missing', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { getMemberByUserId } = await import('../../../src/services/householdService.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: undefined });
    expect(await getMemberByUserId('hh', 'u')).toBeNull();
  });
});
