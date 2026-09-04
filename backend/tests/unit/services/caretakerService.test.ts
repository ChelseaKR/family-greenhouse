/**
 * Unit tests for the caretaker-seat service: the credential lifecycle and the
 * visit ledger that makes proof-of-visit possible.
 *
 * The assertions that matter most are the negative ones — a revoked or
 * out-of-window token resolves to null with no distinguishing signal, a failed
 * visit read is allowed to throw rather than reading as "no visits", and the
 * permission surface stays disjoint from everything a member can do.
 */
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
  const svc = await import('../../../src/services/caretakerService.js');
  return { dynamodb, svc };
}

const HH = 'hh-1';
const TOKEN = 'a'.repeat(64);

function activeRow(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    Item: {
      id: 'seat-1',
      token: TOKEN,
      householdId: HH,
      createdBy: 'u1',
      createdAt: new Date(now - 1000).toISOString(),
      startsAt: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      status: 'active',
      name: 'Dana',
      ...overrides,
    },
  };
}

class ConditionalCheckFailed extends Error {
  name = 'ConditionalCheckFailedException';
}

describe('caretaker permission surface', () => {
  it('is exactly the three documented actions', async () => {
    const { svc } = await load();
    expect(svc.CARETAKER_PERMISSIONS).toEqual(['task.complete', 'photo.add', 'note.add']);
  });

  it('shares nothing with the capabilities reserved to members', async () => {
    const { svc } = await load();
    const forbidden = new Set<string>(svc.CARETAKER_FORBIDDEN_CAPABILITIES);
    for (const permission of svc.CARETAKER_PERMISSIONS) {
      expect(forbidden.has(permission)).toBe(false);
    }
    // The forbidden list names the things a caretaker must never gain; if a
    // future permission is added that also appears there, this fails.
    expect(forbidden.has('plant.edit')).toBe(true);
    expect(forbidden.has('caretaker.manage')).toBe(true);
    expect(forbidden.has('billing.manage')).toBe(true);
  });
});

describe('createCaretaker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mints a 256-bit token, keys the row on it, and sets a TTL past expiry', async () => {
    const { dynamodb, svc } = await load();
    vi.mocked(dynamodb.send).mockResolvedValue({} as never);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const seat = await svc.createCaretaker({
      householdId: HH,
      createdBy: 'u1',
      name: 'Dana',
      startsAt: new Date().toISOString(),
      expiresAt,
    });

    expect(seat.token).toMatch(/^[0-9a-f]{64}$/);
    const put = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      input: { Item: Record<string, unknown> };
    };
    expect(put.input.Item.PK).toBe(`CARETAKER#${seat.token}`);
    expect(put.input.Item.GSI1PK).toBe(`HOUSEHOLD#${HH}#CARETAKER`);
    expect(put.input.Item.name).toBe('Dana');
    expect(put.input.Item.ttl as number).toBeGreaterThan(Date.parse(expiresAt) / 1000);
  });

  it('never returns the token from the summary view', async () => {
    const { dynamodb, svc } = await load();
    vi.mocked(dynamodb.send).mockResolvedValue({} as never);
    const seat = await svc.createCaretaker({
      householdId: HH,
      createdBy: 'u1',
      name: 'Dana',
      startsAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect('token' in svc.toSummary(seat)).toBe(false);
  });
});

describe('getActiveCaretaker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves an in-window active seat', async () => {
    const { dynamodb, svc } = await load();
    vi.mocked(dynamodb.send).mockResolvedValue(activeRow() as never);
    const seat = await svc.getActiveCaretaker(TOKEN);
    expect(seat?.name).toBe('Dana');
  });

  it('rejects a malformed token without touching DynamoDB', async () => {
    const { dynamodb, svc } = await load();
    expect(await svc.getActiveCaretaker('nope')).toBeNull();
    expect(await svc.getActiveCaretaker(`${TOKEN}A`)).toBeNull();
    expect(dynamodb.send).not.toHaveBeenCalled();
  });

  it.each([
    ['revoked', { status: 'revoked' }],
    ['expired', { expiresAt: new Date(Date.now() - 1000).toISOString() }],
    ['not yet open', { startsAt: new Date(Date.now() + 60_000).toISOString() }],
  ])('returns null for a %s seat, with no distinguishing signal', async (_label, overrides) => {
    const { dynamodb, svc } = await load();
    vi.mocked(dynamodb.send).mockResolvedValue(activeRow(overrides) as never);
    expect(await svc.getActiveCaretaker(TOKEN)).toBeNull();
  });

  it('returns null for a missing row', async () => {
    const { dynamodb, svc } = await load();
    vi.mocked(dynamodb.send).mockResolvedValue({} as never);
    expect(await svc.getActiveCaretaker(TOKEN)).toBeNull();
  });
});

describe('revokeCaretaker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('revokes a seat that belongs to the household', async () => {
    const { dynamodb, svc } = await load();
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({ Items: [activeRow().Item] } as never)
      .mockResolvedValueOnce({} as never);
    expect(await svc.revokeCaretaker(HH, 'seat-1')).toBe(true);
    const update = vi.mocked(dynamodb.send).mock.calls[1][0] as unknown as {
      input: { Key: Record<string, string> };
    };
    expect(update.input.Key.PK).toBe(`CARETAKER#${TOKEN}`);
  });

  it('refuses an id that is not in this household’s partition', async () => {
    const { dynamodb, svc } = await load();
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Items: [] } as never);
    expect(await svc.revokeCaretaker(HH, 'seat-1')).toBe(false);
    expect(dynamodb.send).toHaveBeenCalledTimes(1);
  });
});

describe('recordCaretakerAction', () => {
  const seat = { id: 'seat-1', householdId: HH, name: 'Dana' };
  const entry = {
    taskId: 't1',
    plantId: 'p1',
    plantName: 'Monstera',
    taskType: 'water',
    at: new Date().toISOString(),
  };

  beforeEach(() => vi.clearAllMocks());

  it('opens a visit whose startedAt is the first action, not a claimed time', async () => {
    const { dynamodb, svc } = await load();
    // No open-visit pointer, then two writes (visit row + pointer).
    vi.mocked(dynamodb.send).mockResolvedValue({} as never);
    const now = new Date('2026-09-03T09:00:00.000Z');

    const visitId = await svc.recordCaretakerAction(seat, { kind: 'task', entry }, now);

    const put = vi.mocked(dynamodb.send).mock.calls[1][0] as unknown as {
      input: { Item: Record<string, unknown> };
    };
    expect(put.input.Item.PK).toBe(`HOUSEHOLD#${HH}#CARETAKER_VISIT`);
    expect(put.input.Item.SK).toBe(`VISIT#${now.toISOString()}#${visitId}`);
    expect(put.input.Item.startedAt).toBe(now.toISOString());
    expect(put.input.Item.caretakerName).toBe('Dana');
    expect(put.input.Item.taskCount).toBe(1);
  });

  it('folds a second action within the idle window into the same visit', async () => {
    const { dynamodb, svc } = await load();
    const started = '2026-09-03T09:00:00.000Z';
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({
        Item: { visitId: 'v1', startedAt: started, lastActionAt: started },
      } as never)
      .mockResolvedValue({} as never);

    const visitId = await svc.recordCaretakerAction(
      seat,
      { kind: 'note', entry: { text: 'All watered.', at: started } },
      new Date('2026-09-03T10:00:00.000Z')
    );

    expect(visitId).toBe('v1');
    const update = vi.mocked(dynamodb.send).mock.calls[1][0] as unknown as {
      input: { Key: Record<string, string>; UpdateExpression: string };
    };
    expect(update.input.Key.SK).toBe(`VISIT#${started}#v1`);
    expect(update.input.UpdateExpression).toContain('list_append');
  });

  it('starts a NEW visit once the idle window has passed', async () => {
    const { dynamodb, svc } = await load();
    const started = '2026-09-03T09:00:00.000Z';
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({
        Item: { visitId: 'v1', startedAt: started, lastActionAt: started },
      } as never)
      .mockResolvedValue({} as never);

    // 7 hours later — past VISIT_IDLE_MS, so this is a second trip to the
    // house, not a continuation of the first.
    const visitId = await svc.recordCaretakerAction(
      seat,
      { kind: 'task', entry },
      new Date('2026-09-03T16:00:00.000Z')
    );
    expect(visitId).not.toBe('v1');
  });

  it('keeps the count exact when the detail array is already full', async () => {
    const { dynamodb, svc } = await load();
    const started = '2026-09-03T09:00:00.000Z';
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({
        Item: { visitId: 'v1', startedAt: started, lastActionAt: started },
      } as never)
      // The size(#list) < cap condition fails …
      .mockRejectedValueOnce(new ConditionalCheckFailed())
      // … but the count-only update succeeds, so the visit still exists.
      .mockResolvedValue({} as never);

    const visitId = await svc.recordCaretakerAction(
      seat,
      { kind: 'task', entry },
      new Date('2026-09-03T09:30:00.000Z')
    );
    expect(visitId).toBe('v1');
    const countOnly = vi.mocked(dynamodb.send).mock.calls[2][0] as unknown as {
      input: { UpdateExpression: string };
    };
    expect(countOnly.input.UpdateExpression).toContain('ADD');
    expect(countOnly.input.UpdateExpression).not.toContain('list_append');
  });

  it('opens a fresh visit when the pointed-at row has gone', async () => {
    const { dynamodb, svc } = await load();
    const started = '2026-09-03T09:00:00.000Z';
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({
        Item: { visitId: 'v1', startedAt: started, lastActionAt: started },
      } as never)
      .mockRejectedValueOnce(new ConditionalCheckFailed())
      .mockRejectedValueOnce(new ConditionalCheckFailed())
      .mockResolvedValue({} as never);

    const visitId = await svc.recordCaretakerAction(
      seat,
      { kind: 'task', entry },
      new Date('2026-09-03T09:30:00.000Z')
    );
    expect(visitId).not.toBe('v1');
  });
});

describe('listVisits', () => {
  beforeEach(() => vi.clearAllMocks());

  it('queries the visit partition by the range and ignores pointer rows', async () => {
    const { dynamodb, svc } = await load();
    vi.mocked(dynamodb.send).mockResolvedValue({
      Items: [
        { entityType: 'CaretakerOpenVisit', visitId: 'v1' },
        {
          entityType: 'CaretakerVisit',
          id: 'v1',
          householdId: HH,
          caretakerId: 'seat-1',
          caretakerName: 'Dana',
          startedAt: '2026-09-03T09:00:00.000Z',
          lastActionAt: '2026-09-03T09:30:00.000Z',
          tasksCompleted: [],
          photos: [],
          notes: [],
          taskCount: 2,
          photoCount: 0,
          noteCount: 0,
        },
      ],
    } as never);

    const visits = await svc.listVisits(HH, '2026-09-01T00:00:00.000Z', '2026-09-30T00:00:00.000Z');
    expect(visits).toHaveLength(1);
    expect(visits[0].taskCount).toBe(2);

    const query = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      input: { ExpressionAttributeValues: Record<string, string> };
    };
    expect(query.input.ExpressionAttributeValues[':pk']).toBe(`HOUSEHOLD#${HH}#CARETAKER_VISIT`);
    expect(query.input.ExpressionAttributeValues[':from']).toContain('VISIT#');
  });

  it('lets a failed read throw instead of reporting "no visits"', async () => {
    const { dynamodb, svc } = await load();
    vi.mocked(dynamodb.send).mockRejectedValue(new Error('DynamoDB unavailable'));
    // The whole point: a report that cannot load its data must say so. An
    // empty array here would render a page claiming nobody ever visited.
    await expect(
      svc.listVisits(HH, '2026-09-01T00:00:00.000Z', '2026-09-30T00:00:00.000Z')
    ).rejects.toThrow('DynamoDB unavailable');
  });

  it('follows pagination rather than truncating the record', async () => {
    const { dynamodb, svc } = await load();
    const visit = (id: string) => ({
      entityType: 'CaretakerVisit',
      id,
      householdId: HH,
      caretakerId: 'seat-1',
      caretakerName: 'Dana',
      startedAt: '2026-09-03T09:00:00.000Z',
      lastActionAt: '2026-09-03T09:30:00.000Z',
      tasksCompleted: [],
      photos: [],
      notes: [],
      taskCount: 0,
      photoCount: 0,
      noteCount: 0,
    });
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({ Items: [visit('v1')], LastEvaluatedKey: { PK: 'x' } } as never)
      .mockResolvedValueOnce({ Items: [visit('v2')] } as never);

    const visits = await svc.listVisits(HH, '2026-09-01', '2026-09-30');
    expect(visits.map((v) => v.id)).toEqual(['v1', 'v2']);
  });
});
