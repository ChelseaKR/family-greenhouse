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
    // Plan-cap counters are born initialized: the creator is the first
    // member, and there are no plants yet.
    const householdItem = items.find((i) => i.entityType === 'Household');
    expect(householdItem?.memberCount).toBe(1);
    expect(householdItem?.plantCount).toBe(0);
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

  // Shape of the TransactWrite payload addMember sends.
  type AddMemberTransact = {
    kind: string;
    input: {
      TransactItems: [
        { Put: { Item: Record<string, unknown>; ConditionExpression: string } },
        {
          Update: {
            Key: { SK: string };
            UpdateExpression: string;
            ConditionExpression: string;
            ExpressionAttributeValues: Record<string, unknown>;
          };
        },
      ];
    };
  };

  it('addMember defaults to member role', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { addMember } = await import('../../../src/services/householdService.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: { memberCount: 1 } }); // METADATA read
    vi.mocked(dynamodb.send).mockResolvedValueOnce({}); // TransactWrite
    const result = await addMember('hh', 'u', 'Name', 'e@x.com', 6);
    expect(result.role).toBe('member');
  });

  it('addMember transacts the conditional member Put with a capped memberCount increment', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { addMember } = await import('../../../src/services/householdService.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: { memberCount: 2 } });
    vi.mocked(dynamodb.send).mockResolvedValueOnce({});
    await addMember('hh', 'u', 'Name', 'e@x.com', 6);
    const cmd = vi.mocked(dynamodb.send).mock.calls[1][0] as unknown as AddMemberTransact;
    expect(cmd.kind).toBe('TransactWrite');
    const [putItem, counter] = cmd.input.TransactItems;
    // Without this condition a racing second join silently overwrote the
    // winner's row (e.g. demoting an admin back to 'member').
    expect(putItem.Put.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(putItem.Put.Item).toMatchObject({ SK: 'MEMBER#u', entityType: 'HouseholdMember' });
    expect(counter.Update.Key.SK).toBe('METADATA');
    expect(counter.Update.UpdateExpression).toBe(
      'SET memberCount = if_not_exists(memberCount, :base) + :one'
    );
    expect(counter.Update.ConditionExpression).toBe(
      'attribute_exists(PK) AND (attribute_not_exists(memberCount) OR memberCount < :max)'
    );
    expect(counter.Update.ExpressionAttributeValues).toEqual({ ':base': 0, ':one': 1, ':max': 6 });
  });

  it('addMember maps a member-row cancellation to ConditionalCheckFailedException (already a member)', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { addMember } = await import('../../../src/services/householdService.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: { memberCount: 1 } });
    vi.mocked(dynamodb.send).mockRejectedValueOnce(
      Object.assign(new Error('cancelled'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
      })
    );
    await expect(addMember('hh', 'u', 'Name', 'e@x.com', 6)).rejects.toMatchObject({
      name: 'ConditionalCheckFailedException',
    });
  });

  it('addMember maps a memberCount-cap cancellation to PlanLimitError (concurrent joins)', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { addMember } = await import('../../../src/services/householdService.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: { memberCount: 5 } });
    // Two concurrent joins both read 5 of 6 — DynamoDB serializes the
    // transactions; the loser's counter condition fails at commit time.
    vi.mocked(dynamodb.send).mockRejectedValueOnce(
      Object.assign(new Error('cancelled'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
      })
    );
    await expect(addMember('hh', 'u', 'Name', 'e@x.com', 6)).rejects.toMatchObject({
      name: 'PlanLimitError',
    });
  });

  it('addMember lazily backfills memberCount from the real member rows on legacy households', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { addMember } = await import('../../../src/services/householdService.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: { id: 'hh' } }); // no memberCount
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Items: [
        { householdId: 'hh', userId: 'a', role: 'admin' },
        { householdId: 'hh', userId: 'b', role: 'member' },
      ],
    }); // member-rows query for the backfill base
    vi.mocked(dynamodb.send).mockResolvedValueOnce({}); // TransactWrite
    await addMember('hh', 'u', 'Name', 'e@x.com', 6);
    const cmd = vi.mocked(dynamodb.send).mock.calls[2][0] as unknown as AddMemberTransact;
    expect(cmd.input.TransactItems[1].Update.ExpressionAttributeValues[':base']).toBe(2);
  });

  it('addMember rejects with PlanLimitError before writing when a legacy household is at cap', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { addMember } = await import('../../../src/services/householdService.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: { id: 'hh' } });
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Items: [{ householdId: 'hh', userId: 'a', role: 'admin' }],
    });
    await expect(addMember('hh', 'u', 'Name', 'e@x.com', 1)).rejects.toMatchObject({
      name: 'PlanLimitError',
    });
    // METADATA read + members query only — no TransactWrite attempted.
    expect(vi.mocked(dynamodb.send).mock.calls).toHaveLength(2);
  });

  it('removeMember transacts the member delete with a floored memberCount decrement', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { removeMember } = await import('../../../src/services/householdService.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({});
    await removeMember('hh', 'u');
    const cmd = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      kind: string;
      input: {
        TransactItems: [
          { Delete: { Key: { SK: string }; ConditionExpression: string } },
          {
            Update: { Key: { SK: string }; UpdateExpression: string; ConditionExpression: string };
          },
        ];
      };
    };
    expect(cmd.kind).toBe('TransactWrite');
    const [del, counter] = cmd.input.TransactItems;
    expect(del.Delete.Key.SK).toBe('MEMBER#u');
    expect(del.Delete.ConditionExpression).toBe('attribute_exists(PK)');
    expect(counter.Update.Key.SK).toBe('METADATA');
    expect(counter.Update.UpdateExpression).toBe(
      'SET memberCount = if_not_exists(memberCount, :one) - :one'
    );
    // Floor at 0.
    expect(counter.Update.ConditionExpression).toBe(
      'attribute_exists(PK) AND (attribute_not_exists(memberCount) OR memberCount > :zero)'
    );
  });

  it('removeMember stays idempotent when the member row is already gone (no counter touch)', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { removeMember } = await import('../../../src/services/householdService.js');
    vi.mocked(dynamodb.send).mockRejectedValueOnce(
      Object.assign(new Error('cancelled'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
      })
    );
    await expect(removeMember('hh', 'u')).resolves.toBeUndefined();
    // No fallback delete — the row was already gone.
    expect(vi.mocked(dynamodb.send).mock.calls).toHaveLength(1);
  });

  it('removeMember falls back to a plain delete when only the counter floor blocked the transaction', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { removeMember } = await import('../../../src/services/householdService.js');
    // Counter already 0 (drift on a legacy row): the member row still exists
    // and must be removed even though the decrement can't go below 0.
    vi.mocked(dynamodb.send).mockRejectedValueOnce(
      Object.assign(new Error('cancelled'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
      })
    );
    vi.mocked(dynamodb.send).mockResolvedValueOnce({});
    await removeMember('hh', 'u');
    const calls = vi.mocked(dynamodb.send).mock.calls;
    expect(calls).toHaveLength(2);
    const fallback = calls[1][0] as unknown as { kind: string; input: { Key: { SK: string } } };
    expect(fallback.kind).toBe('Delete');
    expect(fallback.input.Key.SK).toBe('MEMBER#u');
  });

  it('getMemberByUserId returns null when missing', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { getMemberByUserId } = await import('../../../src/services/householdService.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: undefined });
    expect(await getMemberByUserId('hh', 'u')).toBeNull();
  });
});
