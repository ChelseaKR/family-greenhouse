/**
 * Unit tests for the kiosk (wall display) link service.
 *
 * The properties under test are the ones the threat model in
 * `services/kioskService.ts` depends on: a 256-bit token, no TTL (the link is
 * long-lived on purpose), re-issue that actually revokes the old token, a
 * generic null on every lookup failure, and a read failure that PROPAGATES
 * rather than collapsing into "there is no kiosk link".
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
  const svc = await import('../../../src/services/kioskService.js');
  return { dynamodb, svc };
}

const HH = 'hh-1';
const TOKEN = 'a'.repeat(64);

function activeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'kiosk-1',
    token: TOKEN,
    householdId: HH,
    createdBy: 'u1',
    createdAt: '2026-09-01T00:00:00.000Z',
    status: 'active',
    pollIntervalSeconds: 300,
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('kioskService poll-interval constants', () => {
  it('defaults to a five-minute poll and bounds the configurable range', async () => {
    const { svc } = await load();
    // The default is the ~$0.01/household/month figure the feature is costed
    // at; the floor is the ~$0.05 one. Changing either changes the bill.
    expect(svc.KIOSK_DEFAULT_POLL_SECONDS).toBe(300);
    expect(svc.KIOSK_MIN_POLL_SECONDS).toBe(60);
    expect(svc.KIOSK_MAX_POLL_SECONDS).toBe(3600);
  });

  it('clamps a requested interval into the supported band', async () => {
    const { svc } = await load();
    expect(svc.clampPollInterval(undefined)).toBe(300);
    expect(svc.clampPollInterval(Number.NaN)).toBe(300);
    expect(svc.clampPollInterval(5)).toBe(60);
    expect(svc.clampPollInterval(99_999)).toBe(3600);
    expect(svc.clampPollInterval(120)).toBe(120);
    expect(svc.clampPollInterval(120.4)).toBe(120);
  });

  it('looks one day ahead, not the sitter view’s seven', async () => {
    const { svc } = await load();
    expect(svc.KIOSK_LOOKAHEAD_DAYS).toBe(1);
  });
});

describe('kioskService.issueKioskLink', () => {
  it('mints a 256-bit hex token on a KIOSK# row with NO ttl', async () => {
    const { dynamodb, svc } = await load();
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({ Items: [] } as never) // revoke pass: list
      .mockResolvedValueOnce({} as never); // put

    const link = await svc.issueKioskLink({ householdId: HH, createdBy: 'u1' });

    expect(link.token).toMatch(/^[0-9a-f]{64}$/);
    const put = vi.mocked(dynamodb.send).mock.calls[1][0] as unknown as {
      input: { Item: Record<string, unknown> };
    };
    expect(put.input.Item.PK).toBe(`KIOSK#${link.token}`);
    expect(put.input.Item.SK).toBe('METADATA');
    expect(put.input.Item.GSI1PK).toBe(`HOUSEHOLD#${HH}#KIOSK`);
    expect(put.input.Item.entityType).toBe('KioskLink');
    // No TTL: a wall display that expires on a timer is a broken wall display.
    expect(put.input.Item.ttl).toBeUndefined();
    expect(put.input.Item.pollIntervalSeconds).toBe(300);
  });

  it('revokes any existing active link BEFORE writing the new one', async () => {
    const { dynamodb, svc } = await load();
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({ Items: [activeRow()] } as never) // list
      .mockResolvedValueOnce({} as never) // update → revoked
      .mockResolvedValueOnce({} as never); // put

    await svc.issueKioskLink({ householdId: HH, createdBy: 'u1' });

    const kinds = vi
      .mocked(dynamodb.send)
      .mock.calls.map(([c]) => (c as unknown as { kind: string }).kind);
    // Revoke lands before the new token exists — a photographed screen must
    // never be left working alongside the replacement.
    expect(kinds).toEqual(['Query', 'Update', 'Put']);
    const update = vi.mocked(dynamodb.send).mock.calls[1][0] as unknown as {
      input: { Key: Record<string, string>; ExpressionAttributeValues: Record<string, string> };
    };
    expect(update.input.Key).toEqual({ PK: `KIOSK#${TOKEN}`, SK: 'METADATA' });
    expect(update.input.ExpressionAttributeValues[':revoked']).toBe('revoked');
  });

  it('clamps a caller-supplied poll interval', async () => {
    const { dynamodb, svc } = await load();
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({ Items: [] } as never)
      .mockResolvedValueOnce({} as never);

    const link = await svc.issueKioskLink({
      householdId: HH,
      createdBy: 'u1',
      pollIntervalSeconds: 1,
    });
    expect(link.pollIntervalSeconds).toBe(60);
  });
});

describe('kioskService.getActiveKioskLink', () => {
  it('returns the link for a live token', async () => {
    const { dynamodb, svc } = await load();
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Item: activeRow() } as never);
    const link = await svc.getActiveKioskLink(TOKEN);
    expect(link?.householdId).toBe(HH);
  });

  it('never hits DynamoDB for a malformed token', async () => {
    const { dynamodb, svc } = await load();
    expect(await svc.getActiveKioskLink('nope')).toBeNull();
    expect(await svc.getActiveKioskLink('A'.repeat(64))).toBeNull();
    expect(await svc.getActiveKioskLink('')).toBeNull();
    expect(dynamodb.send).not.toHaveBeenCalled();
  });

  it('returns null for a revoked token and for a missing row', async () => {
    const { dynamodb, svc } = await load();
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Item: activeRow({ status: 'revoked' }),
    } as never);
    expect(await svc.getActiveKioskLink(TOKEN)).toBeNull();

    vi.mocked(dynamodb.send).mockResolvedValueOnce({} as never);
    expect(await svc.getActiveKioskLink(TOKEN)).toBeNull();
  });

  it('does NOT expire on its own — a year-old link still resolves', async () => {
    const { dynamodb, svc } = await load();
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Item: activeRow({ createdAt: '2020-01-01T00:00:00.000Z' }),
    } as never);
    expect(await svc.getActiveKioskLink(TOKEN)).not.toBeNull();
  });
});

describe('kioskService.getCurrentKioskLink', () => {
  it('returns the summary without the secret token', async () => {
    const { dynamodb, svc } = await load();
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Items: [activeRow()] } as never);
    const summary = await svc.getCurrentKioskLink(HH);
    expect(summary).toMatchObject({ id: 'kiosk-1', pollIntervalSeconds: 300 });
    expect(summary as unknown as Record<string, unknown>).not.toHaveProperty('token');
  });

  it('returns null when the household has only revoked links', async () => {
    const { dynamodb, svc } = await load();
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Items: [activeRow({ status: 'revoked' })],
    } as never);
    expect(await svc.getCurrentKioskLink(HH)).toBeNull();
  });

  it('THROWS on a failed read rather than reporting "no kiosk link"', async () => {
    const { dynamodb, svc } = await load();
    vi.mocked(dynamodb.send).mockRejectedValueOnce(new Error('dynamo down') as never);
    // ADR 0010: "we could not look" must never render as "nothing is watching
    // your task list". The settings card needs the error, not a null.
    await expect(svc.getCurrentKioskLink(HH)).rejects.toThrow('dynamo down');
  });
});

describe('kioskService.revokeKioskLinks', () => {
  it('flips every active link and reports how many', async () => {
    const { dynamodb, svc } = await load();
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({
        Items: [activeRow(), activeRow({ id: 'k2', token: 'b'.repeat(64) })],
      } as never)
      .mockResolvedValueOnce({} as never)
      .mockResolvedValueOnce({} as never);

    expect(await svc.revokeKioskLinks(HH)).toBe(2);
  });

  it('reports 0 when nothing was live (so the handler can 404)', async () => {
    const { dynamodb, svc } = await load();
    vi.mocked(dynamodb.send).mockResolvedValueOnce({ Items: [] } as never);
    expect(await svc.revokeKioskLinks(HH)).toBe(0);
  });

  it('THROWS on a failed read rather than reporting 0 revoked', async () => {
    const { dynamodb, svc } = await load();
    vi.mocked(dynamodb.send).mockRejectedValueOnce(new Error('dynamo down') as never);
    await expect(svc.revokeKioskLinks(HH)).rejects.toThrow('dynamo down');
  });
});

// #449: a kiosk link never expires and shows the whole household's task list,
// so a member who is removed keeps a live window into the house from anywhere
// unless the link they issued is revoked with them.
describe('kioskService.revokeKioskLinksCreatedBy', () => {
  it('revokes only the departing member’s active links', async () => {
    const { dynamodb, svc } = await load();
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({
        Items: [
          activeRow({ createdBy: 'departing' }),
          activeRow({ id: 'k2', token: 'b'.repeat(64), createdBy: 'staying' }),
          activeRow({ id: 'k3', token: 'c'.repeat(64), createdBy: 'departing', status: 'revoked' }),
        ],
      } as never)
      .mockResolvedValueOnce({} as never);

    expect(await svc.revokeKioskLinksCreatedBy(HH, 'departing')).toBe(1);
    const writes = vi
      .mocked(dynamodb.send)
      .mock.calls.map((c) => c[0] as unknown as { kind: string; input: { Key?: { PK: string } } })
      .filter((c) => c.kind === 'Update');
    expect(writes).toHaveLength(1);
    expect(writes[0].input.Key?.PK).toBe(`KIOSK#${TOKEN}`);
  });

  it('reports 0 when the departing member issued none', async () => {
    const { dynamodb, svc } = await load();
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Items: [activeRow({ createdBy: 'someone-else' })],
    } as never);
    expect(await svc.revokeKioskLinksCreatedBy(HH, 'departing')).toBe(0);
  });

  it('THROWS on a failed read rather than reporting 0 revoked', async () => {
    const { dynamodb, svc } = await load();
    vi.mocked(dynamodb.send).mockRejectedValueOnce(new Error('dynamo down') as never);
    await expect(svc.revokeKioskLinksCreatedBy(HH, 'departing')).rejects.toThrow('dynamo down');
  });
});

/**
 * `revokeKioskLinks` and `revokeKioskLinksCreatedBy` both read through
 * `listKioskLinks`, so a truncated listing made "revoke everything live"
 * quietly not revoke everything — and returned a count that said it had.
 * (#455 / #457 gap 2)
 */
describe('kioskService — the link list is the whole link list', () => {
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
        Items: [activeRow({ id: 'kiosk-new' })],
        LastEvaluatedKey: { PK: 'KIOSK#new' },
      } as never)
      .mockResolvedValueOnce({ Items: [activeRow({ id: 'kiosk-old' })] } as never);

    const links = await svc.listKioskLinks(HH);
    expect(links.map((l) => l.id)).toEqual(['kiosk-new', 'kiosk-old']);
    const second = vi.mocked(dynamodb.send).mock.calls[1][0] as unknown as {
      input: { ExclusiveStartKey?: Record<string, unknown> };
    };
    expect(second.input.ExclusiveStartKey).toEqual({ PK: 'KIOSK#new' });
  });

  it('revoke-all reaches a live link on the second page, and counts it', async () => {
    const { dynamodb, svc } = await load();
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({
        Items: [activeRow({ id: 'kiosk-new', token: 'n'.repeat(64), status: 'revoked' })],
        LastEvaluatedKey: { PK: 'KIOSK#new' },
      } as never)
      .mockResolvedValueOnce({
        Items: [activeRow({ id: 'kiosk-old', token: 'o'.repeat(64) })],
      } as never)
      .mockResolvedValueOnce({} as never);

    expect(await svc.revokeKioskLinks(HH)).toBe(1);
    const writes = vi
      .mocked(dynamodb.send)
      .mock.calls.map((c) => c[0] as unknown as { kind: string; input: { Key?: { PK: string } } })
      .filter((c) => c.kind === 'Update');
    expect(writes).toHaveLength(1);
    expect(writes[0].input.Key?.PK).toBe(`KIOSK#${'o'.repeat(64)}`);
  });
});
