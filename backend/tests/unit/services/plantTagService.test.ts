/**
 * Unit tests for services/plantTagService.ts (ADR 0016): token minting and
 * row shape, generic-null validation, revoke / re-issue semantics, and the
 * household PIN with its per-tag lockout. DynamoDB is mocked at the command
 * level so each test can assert exactly what was written.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scryptSync } from 'node:crypto';

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

type Cmd = { kind: string; input: Record<string, any> };

async function load() {
  const { dynamodb } = await import('../../../src/utils/dynamodb.js');
  const svc = await import('../../../src/services/plantTagService.js');
  return { dynamodb, svc };
}

const HH = 'hh-1';
const TOKEN = 'a'.repeat(64);

function tagRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tag-1',
    token: TOKEN,
    householdId: HH,
    plantId: 'p1',
    createdBy: 'u1',
    createdAt: '2026-09-01T00:00:00.000Z',
    status: 'active',
    revokedAt: null,
    pinFailures: 0,
    pinLockedUntil: null,
    ...overrides,
  };
}

function sentCommands(send: unknown): Cmd[] {
  return vi.mocked(send as (c: unknown) => unknown).mock.calls.map((c) => c[0] as Cmd);
}

/** Route mocked DynamoDB calls by command kind. */
function respond(
  send: unknown,
  table: Partial<Record<'Get' | 'Query' | 'Put' | 'Update', unknown>>
) {
  vi.mocked(send as (c: Cmd) => Promise<unknown>).mockImplementation((cmd: Cmd) =>
    Promise.resolve(table[cmd.kind as keyof typeof table] ?? {})
  );
}

beforeEach(() => vi.clearAllMocks());

describe('plantTagService.issueTag', () => {
  it('mints a 256-bit hex token and writes a PLANTTAG row projected onto the household GSI', async () => {
    const { dynamodb, svc } = await load();
    respond(dynamodb.send, { Query: { Items: [] } });

    const tag = await svc.issueTag({ householdId: HH, plantId: 'p1', createdBy: 'u1' });

    expect(tag.token).toMatch(/^[0-9a-f]{64}$/);
    expect(tag.status).toBe('active');
    const put = sentCommands(dynamodb.send).find((c) => c.kind === 'Put')!;
    expect(put.input.Item.PK).toBe(`PLANTTAG#${tag.token}`);
    expect(put.input.Item.SK).toBe('METADATA');
    expect(put.input.Item.GSI1PK).toBe(`HOUSEHOLD#${HH}#PLANTTAG`);
    expect(put.input.Item.entityType).toBe('PlantTag');
    expect(put.input.Item.plantId).toBe('p1');
    // No expiry: a label in a pot is permanent until revoked.
    expect(put.input.Item.ttl).toBeUndefined();
  });

  it('revokes the plant’s existing active tag first (issue == re-issue, one active tag per plant)', async () => {
    const { dynamodb, svc } = await load();
    respond(dynamodb.send, {
      Query: { Items: [tagRow(), tagRow({ id: 'other', token: 'b'.repeat(64), plantId: 'p2' })] },
    });

    const tag = await svc.issueTag({ householdId: HH, plantId: 'p1', createdBy: 'u1' });

    const cmds = sentCommands(dynamodb.send);
    const updates = cmds.filter((c) => c.kind === 'Update');
    expect(updates).toHaveLength(1); // only p1's tag, not p2's
    expect(updates[0].input.Key.PK).toBe(`PLANTTAG#${TOKEN}`);
    expect(updates[0].input.ExpressionAttributeValues[':revoked']).toBe('revoked');
    // Revocation lands BEFORE the new row is written.
    expect(cmds.findIndex((c) => c.kind === 'Update')).toBeLessThan(
      cmds.findIndex((c) => c.kind === 'Put')
    );
    expect(tag.token).not.toBe(TOKEN);
  });

  it('mints a fresh token each call', async () => {
    const { dynamodb, svc } = await load();
    respond(dynamodb.send, { Query: { Items: [] } });
    const a = await svc.issueTag({ householdId: HH, plantId: 'p1', createdBy: 'u1' });
    const b = await svc.issueTag({ householdId: HH, plantId: 'p1', createdBy: 'u1' });
    expect(a.token).not.toBe(b.token);
  });
});

describe('plantTagService.getActiveTag', () => {
  it('rejects a malformed token WITHOUT touching DynamoDB', async () => {
    const { dynamodb, svc } = await load();
    expect(await svc.getActiveTag('not-hex')).toBeNull();
    expect(await svc.getActiveTag('A'.repeat(64))).toBeNull(); // upper-case is not ours
    expect(dynamodb.send).not.toHaveBeenCalled();
  });

  it('returns null for a missing row', async () => {
    const { dynamodb, svc } = await load();
    respond(dynamodb.send, { Get: {} });
    expect(await svc.getActiveTag(TOKEN)).toBeNull();
  });

  it('returns null for a revoked tag', async () => {
    const { dynamodb, svc } = await load();
    respond(dynamodb.send, { Get: { Item: tagRow({ status: 'revoked' }) } });
    expect(await svc.getActiveTag(TOKEN)).toBeNull();
  });

  it('returns the tag when active, defaulting legacy PIN bookkeeping', async () => {
    const { dynamodb, svc } = await load();
    const row = tagRow();
    delete (row as Record<string, unknown>).pinFailures;
    delete (row as Record<string, unknown>).pinLockedUntil;
    respond(dynamodb.send, { Get: { Item: row } });
    const tag = await svc.getActiveTag(TOKEN);
    expect(tag?.plantId).toBe('p1');
    expect(tag?.pinFailures).toBe(0);
    expect(tag?.pinLockedUntil).toBeNull();
  });
});

describe('plantTagService.revokeTag / revokeTagsForPlant', () => {
  it('returns false for an unknown id and writes nothing', async () => {
    const { dynamodb, svc } = await load();
    respond(dynamodb.send, { Query: { Items: [tagRow()] } });
    expect(await svc.revokeTag(HH, 'nope')).toBe(false);
    expect(sentCommands(dynamodb.send).filter((c) => c.kind === 'Update')).toHaveLength(0);
  });

  it('revokes by opaque id, stamping revokedAt + a sweep TTL, guarded on row existence', async () => {
    const { dynamodb, svc } = await load();
    respond(dynamodb.send, { Query: { Items: [tagRow()] } });
    expect(await svc.revokeTag(HH, 'tag-1')).toBe(true);
    const update = sentCommands(dynamodb.send).find((c) => c.kind === 'Update')!;
    expect(update.input.Key).toEqual({ PK: `PLANTTAG#${TOKEN}`, SK: 'METADATA' });
    expect(update.input.ConditionExpression).toBe('attribute_exists(PK)');
    expect(typeof update.input.ExpressionAttributeValues[':ttl']).toBe('number');
    expect(update.input.ExpressionAttributeValues[':now']).toMatch(/^\d{4}-/);
  });

  it('revokeTagsForPlant only touches that plant’s ACTIVE tags and reports the count', async () => {
    const { dynamodb, svc } = await load();
    respond(dynamodb.send, {
      Query: {
        Items: [
          tagRow(),
          tagRow({ id: 't2', token: 'b'.repeat(64) }),
          tagRow({ id: 't3', token: 'c'.repeat(64), status: 'revoked' }),
          tagRow({ id: 't4', token: 'd'.repeat(64), plantId: 'p2' }),
        ],
      },
    });
    expect(await svc.revokeTagsForPlant(HH, 'p1')).toBe(2);
    const keys = sentCommands(dynamodb.send)
      .filter((c) => c.kind === 'Update')
      .map((c) => c.input.Key.PK);
    expect(keys).toEqual([`PLANTTAG#${'a'.repeat(64)}`, `PLANTTAG#${'b'.repeat(64)}`]);
  });
});

describe('plantTagService PIN', () => {
  const SALT = 'deadbeef'.repeat(4);
  const HASH_1234 = scryptSync('1234', SALT, 32, { N: 16384, r: 8, p: 1 }).toString('hex');
  const pinRow = { Item: { pinHash: HASH_1234, pinSalt: SALT } };

  it('getTagSettings reports pinEnabled from the settings row', async () => {
    const { dynamodb, svc } = await load();
    respond(dynamodb.send, { Get: {} });
    expect(await svc.getTagSettings(HH)).toEqual({ pinEnabled: false });
    respond(dynamodb.send, { Get: pinRow });
    expect(await svc.getTagSettings(HH)).toEqual({ pinEnabled: true });
  });

  it('setTagPin stores a salted hash — never the PIN — on the household partition', async () => {
    const { dynamodb, svc } = await load();
    respond(dynamodb.send, {});
    expect(await svc.setTagPin(HH, '4321', 'u1')).toEqual({ pinEnabled: true });
    const put = sentCommands(dynamodb.send).find((c) => c.kind === 'Put')!;
    expect(put.input.Item.PK).toBe(`HOUSEHOLD#${HH}`);
    expect(put.input.Item.SK).toBe('PLANTTAG#PIN');
    expect(put.input.Item.pinHash).not.toContain('4321');
    expect(put.input.Item.pinHash).toMatch(/^[0-9a-f]{64}$/);
    expect(put.input.Item.pinSalt).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(put.input.Item)).not.toContain('4321');
  });

  it('setTagPin(null) clears the hash', async () => {
    const { dynamodb, svc } = await load();
    respond(dynamodb.send, {});
    expect(await svc.setTagPin(HH, null, 'u1')).toEqual({ pinEnabled: false });
    const update = sentCommands(dynamodb.send).find((c) => c.kind === 'Update')!;
    expect(update.input.UpdateExpression).toContain('REMOVE pinHash, pinSalt');
  });

  it('setTagPin refuses anything but four digits', async () => {
    const { svc } = await load();
    await expect(svc.setTagPin(HH, '12', 'u1')).rejects.toThrow(/four digits/);
    await expect(svc.setTagPin(HH, 'abcd', 'u1')).rejects.toThrow(/four digits/);
  });

  it('verifyTagPin is ok when the household has no PIN', async () => {
    const { dynamodb, svc } = await load();
    respond(dynamodb.send, { Get: {} });
    expect(await svc.verifyTagPin(svc.toSummary(tagRow() as never) as never, undefined)).toEqual({
      verdict: 'ok',
    });
  });

  it('verifyTagPin demands a PIN when one is set and none was sent, without counting a failure', async () => {
    const { dynamodb, svc } = await load();
    respond(dynamodb.send, { Get: pinRow });
    const tag = tagRow() as never;
    expect(await svc.verifyTagPin(tag, undefined)).toEqual({ verdict: 'required' });
    expect(await svc.verifyTagPin(tag, '')).toEqual({ verdict: 'required' });
    expect(sentCommands(dynamodb.send).filter((c) => c.kind === 'Update')).toHaveLength(0);
  });

  it('verifyTagPin accepts the right PIN and clears stale failures', async () => {
    const { dynamodb, svc } = await load();
    respond(dynamodb.send, { Get: pinRow });
    expect(await svc.verifyTagPin(tagRow({ pinFailures: 3 }) as never, '1234')).toEqual({
      verdict: 'ok',
    });
    const update = sentCommands(dynamodb.send).find((c) => c.kind === 'Update')!;
    expect(update.input.UpdateExpression).toContain('pinFailures = :zero');
    expect(update.input.UpdateExpression).toContain('REMOVE pinLockedUntil');
  });

  it('verifyTagPin counts a wrong PIN on the TAG row (ADD, not read-modify-write)', async () => {
    const { dynamodb, svc } = await load();
    respond(dynamodb.send, { Get: pinRow, Update: { Attributes: { pinFailures: 1 } } });
    expect(await svc.verifyTagPin(tagRow() as never, '0000')).toEqual({ verdict: 'wrong' });
    const update = sentCommands(dynamodb.send).find((c) => c.kind === 'Update')!;
    expect(update.input.UpdateExpression).toBe('ADD pinFailures :one');
    expect(update.input.Key.PK).toBe(`PLANTTAG#${TOKEN}`);
  });

  it('verifyTagPin locks the tag on the fifth wrong try for fifteen minutes', async () => {
    const { dynamodb, svc } = await load();
    respond(dynamodb.send, { Get: pinRow, Update: { Attributes: { pinFailures: 5 } } });
    const now = new Date('2026-09-03T12:00:00.000Z');
    const check = await svc.verifyTagPin(tagRow() as never, '0000', now);
    expect(check.verdict).toBe('locked');
    expect(check.lockedUntil).toBe('2026-09-03T12:15:00.000Z');
    const lock = sentCommands(dynamodb.send)
      .filter((c) => c.kind === 'Update')
      .find((c) => String(c.input.UpdateExpression).includes('pinLockedUntil'))!;
    expect(lock.input.ExpressionAttributeValues[':until']).toBe('2026-09-03T12:15:00.000Z');
  });

  it('verifyTagPin honours an existing lock BEFORE looking at the candidate (a locked tag cannot be probed)', async () => {
    const { dynamodb, svc } = await load();
    respond(dynamodb.send, { Get: pinRow });
    const now = new Date('2026-09-03T12:00:00.000Z');
    const locked = tagRow({ pinLockedUntil: '2026-09-03T12:10:00.000Z' }) as never;
    // Even the RIGHT pin is refused while locked, and nothing is written.
    expect(await svc.verifyTagPin(locked, '1234', now)).toEqual({
      verdict: 'locked',
      lockedUntil: '2026-09-03T12:10:00.000Z',
    });
    expect(sentCommands(dynamodb.send).filter((c) => c.kind === 'Update')).toHaveLength(0);
    // Once the window passes, the lock is ignored.
    const later = new Date('2026-09-03T12:20:00.000Z');
    expect((await svc.verifyTagPin(locked, '1234', later)).verdict).toBe('ok');
  });
});

describe('plantTagService.toSummary', () => {
  it('strips the secret token and the PIN bookkeeping', async () => {
    const { svc } = await load();
    const summary = svc.toSummary(tagRow({ pinFailures: 2 }) as never);
    expect(summary).toEqual({
      id: 'tag-1',
      householdId: HH,
      plantId: 'p1',
      createdBy: 'u1',
      createdAt: '2026-09-01T00:00:00.000Z',
      status: 'active',
      revokedAt: null,
    });
    expect(JSON.stringify(summary)).not.toContain(TOKEN);
  });
});

// #449: a tag never expires, so revocation is the only control — and the
// token is printed on a label the departing member may have kept, or listed
// in bulk on the way out (#451).
describe('plantTagService.revokeTagsCreatedBy', () => {
  it('revokes only the departing member’s active tags, and counts them', async () => {
    const { dynamodb, svc } = await load();
    respond(dynamodb.send, {
      Query: {
        Items: [
          tagRow({ createdBy: 'departing' }),
          tagRow({ id: 'tag-2', token: 'b'.repeat(64), createdBy: 'staying' }),
          tagRow({ id: 'tag-3', token: 'c'.repeat(64), createdBy: 'departing', status: 'revoked' }),
          tagRow({ id: 'tag-4', token: 'd'.repeat(64), createdBy: 'departing' }),
        ],
      },
    });

    expect(await svc.revokeTagsCreatedBy(HH, 'departing')).toBe(2);
    const updates = sentCommands(dynamodb.send).filter((c) => c.kind === 'Update');
    expect(updates.map((c) => c.input.Key.PK)).toEqual([
      `PLANTTAG#${TOKEN}`,
      `PLANTTAG#${'d'.repeat(64)}`,
    ]);
    // Revoked rows get a TTL so they sweep themselves — same contract as
    // every other revoke path.
    expect(updates[0].input.ExpressionAttributeValues[':ttl']).toBeGreaterThan(0);
  });

  it('reports 0 when the departing member issued none', async () => {
    const { dynamodb, svc } = await load();
    respond(dynamodb.send, { Query: { Items: [tagRow({ createdBy: 'someone-else' })] } });
    expect(await svc.revokeTagsCreatedBy(HH, 'departing')).toBe(0);
    expect(sentCommands(dynamodb.send).filter((c) => c.kind === 'Update')).toHaveLength(0);
  });

  it('THROWS on a failed read rather than reporting 0 revoked', async () => {
    const { dynamodb, svc } = await load();
    vi.mocked(dynamodb.send).mockRejectedValueOnce(new Error('dynamo down') as never);
    await expect(svc.revokeTagsCreatedBy(HH, 'departing')).rejects.toThrow('dynamo down');
  });
});
