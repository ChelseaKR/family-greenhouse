/**
 * The #450 backfill (services/tokenHashBackfill.ts) against an in-memory table
 * that evaluates the conditions the backfill actually sends, and — the point —
 * against each surface's REAL read path. The property that matters is not
 * "the row moved"; it is "the credential a real person already holds (a
 * printed label, a link in their messages, a wall display) resolves to the
 * same row after the move, and a table dump no longer yields it".
 *
 * Negative controls sit next to the tests they back: a sabotaged surface
 * config is run through the SAME scenario and must produce the failure the
 * real config prevents, and each one asserts its sabotage actually took hold.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { scryptSync } from 'node:crypto';

// ---------------------------------------------------------------------------
// In-memory DynamoDB: just enough of Get / Put / Delete / Scan / TransactWrite
// ---------------------------------------------------------------------------

vi.mock('@aws-sdk/lib-dynamodb', () => {
  const command = (kind: string) =>
    vi.fn(function (input: unknown) {
      return { kind, input };
    });
  return {
    GetCommand: command('Get'),
    PutCommand: command('Put'),
    DeleteCommand: command('Delete'),
    UpdateCommand: command('Update'),
    QueryCommand: command('Query'),
    ScanCommand: command('Scan'),
    BatchWriteCommand: command('BatchWrite'),
    TransactWriteCommand: command('TransactWrite'),
  };
});
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(function () {
    return { send: vi.fn() };
  }),
  ListObjectVersionsCommand: vi.fn(),
  DeleteObjectsCommand: vi.fn(),
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));

type Row = Record<string, unknown>;
type Cmd = { kind: string; input: Record<string, any> };

const rows = new Map<string, Row>();
const keyOf = (pk: unknown, sk: unknown) => `${String(pk)}|${String(sk)}`;
/** Runs just before a TransactWrite is evaluated — a live request landing
 *  between the backfill's scan and its write. */
let beforeTransact: (() => void) | null = null;
const SCAN_PAGE = 2;

class TransactionCanceled extends Error {
  name = 'TransactionCanceledException';
}

/**
 * Evaluates exactly the clause shapes the backfill emits, and THROWS on any
 * other — a fake that shrugged at an unknown clause would let a wrong
 * condition through as a pass.
 */
function conditionHolds(row: Row | undefined, spec: Record<string, any>): boolean {
  const expression: string | undefined = spec.ConditionExpression;
  if (!expression) return true;
  const names: Record<string, string> = spec.ExpressionAttributeNames ?? {};
  const values: Record<string, unknown> = spec.ExpressionAttributeValues ?? {};
  const attr = (token: string) => names[token] ?? token;
  return expression.split(' AND ').every((clause) => {
    let m = clause.match(/^attribute_exists\((\S+)\)$/);
    if (m) return row !== undefined && row[attr(m[1])] !== undefined;
    m = clause.match(/^attribute_not_exists\((\S+)\)$/);
    if (m) return row === undefined || row[attr(m[1])] === undefined;
    m = clause.match(/^attribute_type\((\S+), (\S+)\)$/);
    if (m) {
      if (values[m[2]] !== 'NULL') throw new Error(`fake: unsupported type ${values[m[2]]}`);
      return row !== undefined && row[attr(m[1])] === null;
    }
    m = clause.match(/^(\S+) = (\S+)$/);
    if (m) return row !== undefined && row[attr(m[1])] === values[m[2]];
    throw new Error(`fake: unsupported condition clause "${clause}"`);
  });
}

async function fakeSend(cmd: Cmd): Promise<unknown> {
  const input = cmd.input;
  switch (cmd.kind) {
    case 'Get': {
      const row = rows.get(keyOf(input.Key.PK, input.Key.SK));
      return { Item: row ? structuredClone(row) : undefined };
    }
    case 'Put': {
      const key = keyOf(input.Item.PK, input.Item.SK);
      if (!conditionHolds(rows.get(key), input)) throw new TransactionCanceled('put');
      rows.set(key, structuredClone(input.Item));
      return {};
    }
    case 'Delete':
      rows.delete(keyOf(input.Key.PK, input.Key.SK));
      return {};
    case 'Scan': {
      const prefix = input.ExpressionAttributeValues[':prefix'] as string;
      const plain = input.ExpressionAttributeNames['#plain'] as string;
      expect(input.FilterExpression).toBe('begins_with(PK, :prefix) AND attribute_exists(#plain)');
      const all = [...rows.values()]
        .filter((row) => String(row.PK).startsWith(prefix) && row[plain] !== undefined)
        .sort((a, b) => keyOf(a.PK, a.SK).localeCompare(keyOf(b.PK, b.SK)));
      const start = input.ExclusiveStartKey
        ? all.findIndex(
            (r) =>
              keyOf(r.PK, r.SK) === keyOf(input.ExclusiveStartKey.PK, input.ExclusiveStartKey.SK)
          ) + 1
        : 0;
      const page = all.slice(start, start + SCAN_PAGE);
      const more = start + SCAN_PAGE < all.length;
      const last = page[page.length - 1];
      return {
        Items: page.map((r) => structuredClone(r)),
        LastEvaluatedKey: more && last ? { PK: last.PK, SK: last.SK } : undefined,
      };
    }
    case 'TransactWrite': {
      beforeTransact?.();
      beforeTransact = null;
      const items = input.TransactItems as Array<Record<string, any>>;
      for (const item of items) {
        const spec = item.Put ?? item.Delete;
        const key = item.Put
          ? keyOf(item.Put.Item.PK, item.Put.Item.SK)
          : keyOf(item.Delete.Key.PK, item.Delete.Key.SK);
        if (!conditionHolds(rows.get(key), spec)) throw new TransactionCanceled('condition');
      }
      for (const item of items) {
        if (item.Put)
          rows.set(keyOf(item.Put.Item.PK, item.Put.Item.SK), structuredClone(item.Put.Item));
        else rows.delete(keyOf(item.Delete.Key.PK, item.Delete.Key.SK));
      }
      return {};
    }
    default:
      throw new Error(`fake: unsupported command ${cmd.kind}`);
  }
}

async function load() {
  const { dynamodb } = await import('../../../src/utils/dynamodb.js');
  vi.mocked(dynamodb.send).mockImplementation(fakeSend as never);
  const backfill = await import('../../../src/services/tokenHashBackfill.js');
  return { dynamodb, backfill };
}

beforeEach(() => {
  rows.clear();
  beforeTransact = null;
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures: one pre-#450 row per surface, exactly as the old code wrote it
// (the record spread onto the item, so the plaintext rides along).
// ---------------------------------------------------------------------------

const HH = 'hh-1';
const TAG_TOKEN = '1'.repeat(64);
const KIOSK_TOKEN = '2'.repeat(64);
const SITTER_TOKEN = '3'.repeat(64);
const SEAT_TOKEN = '4'.repeat(64);
const SHARE_CODE = '5'.repeat(32);

const past = () => new Date(Date.now() - 60_000).toISOString();
const future = () => new Date(Date.now() + 86_400_000).toISOString();

function seed(row: Row) {
  rows.set(keyOf(row.PK, row.SK), row);
}

function legacyTag(overrides: Row = {}): Row {
  return {
    PK: `PLANTTAG#${TAG_TOKEN}`,
    SK: 'METADATA',
    GSI1PK: `HOUSEHOLD#${HH}#PLANTTAG`,
    GSI1SK: '2026-06-01T00:00:00.000Z',
    entityType: 'PlantTag',
    id: 'tag-1',
    token: TAG_TOKEN,
    householdId: HH,
    plantId: 'p1',
    createdBy: 'u1',
    createdAt: '2026-06-01T00:00:00.000Z',
    status: 'active',
    revokedAt: null,
    pinFailures: 0,
    pinLockedUntil: null,
    ...overrides,
  };
}

function seedAllSurfaces() {
  seed(legacyTag());
  seed({
    PK: `KIOSK#${KIOSK_TOKEN}`,
    SK: 'METADATA',
    GSI1PK: `HOUSEHOLD#${HH}#KIOSK`,
    entityType: 'KioskLink',
    id: 'kiosk-1',
    token: KIOSK_TOKEN,
    householdId: HH,
    createdBy: 'u1',
    createdAt: '2026-08-01T00:00:00.000Z',
    status: 'active',
    pollIntervalSeconds: 300,
  });
  seed({
    PK: `SITTER#${SITTER_TOKEN}`,
    SK: 'METADATA',
    GSI1PK: `HOUSEHOLD#${HH}#SITTER`,
    entityType: 'SitterLink',
    id: 'link-1',
    token: SITTER_TOKEN,
    householdId: HH,
    createdBy: 'u1',
    createdAt: past(),
    startsAt: past(),
    expiresAt: future(),
    status: 'active',
    label: 'Our plants',
    photoCount: 2,
    ttl: 9_999_999_999,
  });
  seed({
    PK: `CARETAKER#${SEAT_TOKEN}`,
    SK: 'METADATA',
    GSI1PK: `HOUSEHOLD#${HH}#CARETAKER`,
    entityType: 'Caretaker',
    id: 'seat-1',
    token: SEAT_TOKEN,
    householdId: HH,
    createdBy: 'u1',
    createdAt: past(),
    name: 'Dana',
    startsAt: past(),
    expiresAt: future(),
    status: 'active',
    ttl: 9_999_999_999,
  });
  seed({
    PK: `SHARE#${SHARE_CODE}`,
    SK: 'METADATA',
    entityType: 'PlantShare',
    code: SHARE_CODE,
    plantId: 'p1',
    householdId: HH,
    // Minted before #741: the snapshot still carries the private notes.
    plantSnapshot: {
      name: 'Monstera',
      species: null,
      notes: 'PRIVATENOTE-9Q spare key under the pot',
      imageUrl: null,
      tags: [],
    },
    createdBy: 'u1',
    createdAt: past(),
    expiresAt: future(),
    ttl: 9_999_999_999,
  });
}

const tableDump = () => JSON.stringify([...rows.values()]);

function digest(salt: string, token: string): string {
  return scryptSync(token, salt, 32).toString('hex');
}

// ---------------------------------------------------------------------------

describe('tokenHashBackfill — the credentials people already hold keep working', () => {
  it('re-keys every surface so the SAME token resolves through the service’s own read path', async () => {
    const { backfill } = await load();
    seedAllSurfaces();
    const tags = await import('../../../src/services/plantTagService.js');
    const kiosk = await import('../../../src/services/kioskService.js');
    const sitter = await import('../../../src/services/sitterService.js');
    const seats = await import('../../../src/services/caretakerService.js');
    const plants = await import('../../../src/services/plantService.js');

    // Before: all five resolve (through the legacy fallback).
    expect((await tags.getActiveTag(TAG_TOKEN))?.id).toBe('tag-1');
    expect((await kiosk.getActiveKioskLink(KIOSK_TOKEN))?.id).toBe('kiosk-1');
    expect((await sitter.getActiveLink(SITTER_TOKEN))?.id).toBe('link-1');
    expect((await seats.getActiveCaretaker(SEAT_TOKEN))?.id).toBe('seat-1');
    expect((await plants.getPlantShare(SHARE_CODE))?.plantId).toBe('p1');

    for (const name of backfill.BACKFILL_SURFACE_NAMES) {
      const report = await backfill.backfillSurface(backfill.LEGACY_SURFACES[name], {
        apply: true,
      });
      expect(report).toMatchObject({ legacy: 1, rekeyed: 1, raced: 0, skipped: [] });
    }

    // After: the dump carries no token of any surface, and no share note.
    const dump = tableDump();
    for (const secret of [TAG_TOKEN, KIOSK_TOKEN, SITTER_TOKEN, SEAT_TOKEN, SHARE_CODE]) {
      expect(dump).not.toContain(secret);
    }
    expect(dump).not.toContain('PRIVATENOTE-9Q');
    expect(rows.size).toBe(5); // moved, not copied

    // …and the same credentials still resolve, to the same rows.
    expect((await tags.getActiveTag(TAG_TOKEN))?.id).toBe('tag-1');
    expect((await kiosk.getActiveKioskLink(KIOSK_TOKEN))?.id).toBe('kiosk-1');
    expect((await sitter.getActiveLink(SITTER_TOKEN))?.id).toBe('link-1');
    expect((await seats.getActiveCaretaker(SEAT_TOKEN))?.id).toBe('seat-1');
    expect((await plants.getPlantShare(SHARE_CODE))?.plantId).toBe('p1');
  });

  it('keeps every other attribute of a printed label — its PIN lockout, household index, plant', async () => {
    const { backfill } = await load();
    seed(legacyTag({ pinFailures: 3, pinLockedUntil: '2026-09-17T10:00:00.000Z' }));
    await backfill.backfillSurface(backfill.LEGACY_SURFACES.plantTag, { apply: true });

    const hash = digest('family-greenhouse-planttag-v1', TAG_TOKEN);
    const moved = rows.get(keyOf(`PLANTTAG#${hash}`, 'METADATA'))!;
    const {
      token: _plaintext,
      PK: _oldPk,
      ...unchanged
    } = legacyTag({
      pinFailures: 3,
      pinLockedUntil: '2026-09-17T10:00:00.000Z',
    });
    expect(_plaintext).toBe(TAG_TOKEN);
    expect(_oldPk).toBe(`PLANTTAG#${TAG_TOKEN}`);
    expect(moved).toEqual({ ...unchanged, PK: `PLANTTAG#${hash}`, tokenHash: hash });
  });

  it('after the move, a digest from the dump does not scan as a label', async () => {
    const { backfill } = await load();
    seed(legacyTag());
    await backfill.backfillSurface(backfill.LEGACY_SURFACES.plantTag, { apply: true });
    const tags = await import('../../../src/services/plantTagService.js');
    const leaked = digest('family-greenhouse-planttag-v1', TAG_TOKEN);
    // Sabotage-landed check: the digest really is a live row key in the table.
    expect(rows.has(keyOf(`PLANTTAG#${leaked}`, 'METADATA'))).toBe(true);
    expect(await tags.getActiveTag(leaked)).toBeNull();
  });

  it('negative control: a registry entry with the wrong salt strands the label it moved', async () => {
    // Proves the round trip above can fail: re-key under a salt the read path
    // does not use, and the printed label stops scanning.
    const { backfill } = await load();
    seed(legacyTag());
    const wrongSalt = { ...backfill.LEGACY_SURFACES.plantTag, surface: 'kioskLink' as const };
    const report = await backfill.backfillSurface(wrongSalt, { apply: true });
    expect(report.rekeyed).toBe(1); // sabotage landed: the row did move
    const tags = await import('../../../src/services/plantTagService.js');
    expect(await tags.getActiveTag(TAG_TOKEN)).toBeNull();
  });
});

describe('tokenHashBackfill — a live request during the run', () => {
  it('a revocation landing mid-run cancels the move; the label stays revoked', async () => {
    const { backfill } = await load();
    seed(legacyTag());
    beforeTransact = () => {
      const row = rows.get(keyOf(`PLANTTAG#${TAG_TOKEN}`, 'METADATA'))!;
      row.status = 'revoked';
      row.revokedAt = '2026-09-17T12:00:00.000Z';
    };
    const report = await backfill.backfillSurface(backfill.LEGACY_SURFACES.plantTag, {
      apply: true,
    });
    expect(report).toMatchObject({ legacy: 1, rekeyed: 0, raced: 1 });
    const tags = await import('../../../src/services/plantTagService.js');
    expect(await tags.getActiveTag(TAG_TOKEN)).toBeNull();
    // Left exactly where it was, for a re-run to pick up.
    expect(rows.get(keyOf(`PLANTTAG#${TAG_TOKEN}`, 'METADATA'))?.status).toBe('revoked');
    expect(rows.size).toBe(1);

    // The re-run moves it, still revoked.
    const again = await backfill.backfillSurface(backfill.LEGACY_SURFACES.plantTag, {
      apply: true,
    });
    expect(again).toMatchObject({ rekeyed: 1, raced: 0 });
    expect(await tags.getActiveTag(TAG_TOKEN)).toBeNull();
    expect(tableDump()).not.toContain(TAG_TOKEN);
  });

  it('negative control: WITHOUT the unchanged-condition, that revocation is undone', async () => {
    const { backfill } = await load();
    seed(legacyTag());
    beforeTransact = () => {
      rows.get(keyOf(`PLANTTAG#${TAG_TOKEN}`, 'METADATA'))!.status = 'revoked';
    };
    const unguarded = { ...backfill.LEGACY_SURFACES.plantTag, mutableAttributes: [] };
    const report = await backfill.backfillSurface(unguarded, { apply: true });
    // Sabotage landed: the move went through despite the revocation…
    expect(report.rekeyed).toBe(1);
    // …and the revoked label scans again. This is what the condition prevents.
    const tags = await import('../../../src/services/plantTagService.js');
    expect((await tags.getActiveTag(TAG_TOKEN))?.status).toBe('active');
  });

  it('a wrong-PIN attempt landing mid-run cancels the move rather than losing the count', async () => {
    const { backfill } = await load();
    seed(legacyTag({ pinFailures: 4 }));
    beforeTransact = () => {
      rows.get(keyOf(`PLANTTAG#${TAG_TOKEN}`, 'METADATA'))!.pinFailures = 5;
    };
    const report = await backfill.backfillSurface(backfill.LEGACY_SURFACES.plantTag, {
      apply: true,
    });
    expect(report.raced).toBe(1);
    expect(rows.get(keyOf(`PLANTTAG#${TAG_TOKEN}`, 'METADATA'))?.pinFailures).toBe(5);
  });

  it('a lockout SET mid-run (the attribute was null when read) cancels the move', async () => {
    const { backfill } = await load();
    seed(legacyTag());
    beforeTransact = () => {
      rows.get(keyOf(`PLANTTAG#${TAG_TOKEN}`, 'METADATA'))!.pinLockedUntil =
        '2026-09-17T12:15:00.000Z';
    };
    const report = await backfill.backfillSurface(backfill.LEGACY_SURFACES.plantTag, {
      apply: true,
    });
    expect(report.raced).toBe(1);
  });

  it('a row deleted mid-run (a departing member’s share) is not re-created', async () => {
    const { backfill } = await load();
    seedAllSurfaces();
    beforeTransact = () => rows.delete(keyOf(`SHARE#${SHARE_CODE}`, 'METADATA'));
    const report = await backfill.backfillSurface(backfill.LEGACY_SURFACES.plantShare, {
      apply: true,
    });
    expect(report).toMatchObject({ rekeyed: 0, raced: 1 });
    expect([...rows.keys()].some((k) => k.startsWith('SHARE#'))).toBe(false);
  });

  it('never overwrites a hashed row that already exists', async () => {
    const { backfill } = await load();
    seed(legacyTag());
    const hash = digest('family-greenhouse-planttag-v1', TAG_TOKEN);
    seed({
      ...legacyTag({ id: 'already-there' }),
      PK: `PLANTTAG#${hash}`,
      tokenHash: hash,
      token: undefined,
    });
    const report = await backfill.backfillSurface(backfill.LEGACY_SURFACES.plantTag, {
      apply: true,
    });
    expect(report.raced).toBe(1);
    expect(rows.get(keyOf(`PLANTTAG#${hash}`, 'METADATA'))?.id).toBe('already-there');
  });

  it('propagates a write failure that is not a cancelled condition', async () => {
    const { dynamodb, backfill } = await load();
    seed(legacyTag());
    vi.mocked(dynamodb.send).mockImplementation((async (cmd: Cmd) => {
      if (cmd.kind === 'TransactWrite') throw new Error('ProvisionedThroughputExceeded');
      return fakeSend(cmd);
    }) as never);
    await expect(
      backfill.backfillSurface(backfill.LEGACY_SURFACES.plantTag, { apply: true })
    ).rejects.toThrow('ProvisionedThroughputExceeded');
  });
});

describe('tokenHashBackfill — dry run and what it will not touch', () => {
  it('writes nothing without apply, and follows the scan to its last page', async () => {
    const { dynamodb, backfill } = await load();
    for (let i = 0; i < 5; i += 1) {
      const token = 'abcde'[i].repeat(64);
      seed(legacyTag({ PK: `PLANTTAG#${token}`, token, id: `tag-${i}` }));
    }
    const before = tableDump();
    const report = await backfill.backfillSurface(backfill.LEGACY_SURFACES.plantTag, {
      apply: false,
    });
    expect(report).toMatchObject({ legacy: 5, rekeyed: 0, raced: 0 });
    expect(tableDump()).toBe(before);
    const kinds = vi.mocked(dynamodb.send).mock.calls.map((c) => (c[0] as unknown as Cmd).kind);
    expect(kinds.every((k) => k === 'Scan')).toBe(true);
    expect(kinds.length).toBe(3); // 5 rows at 2 per page
  });

  it('skips, and reports without the token, any row it cannot prove is a legacy row', async () => {
    const { backfill } = await load();
    const other = 'e'.repeat(64);
    seed(legacyTag({ PK: `PLANTTAG#${other}`, id: 'mismatch' })); // PK is not its own token
    seed(legacyTag({ PK: 'PLANTTAG#short', token: 'short', id: 'bad-shape' }));
    seed(legacyTag({ SK: 'SOMETHING-ELSE', id: 'not-metadata' }));
    const report = await backfill.backfillSurface(backfill.LEGACY_SURFACES.plantTag, {
      apply: true,
    });
    expect(report.rekeyed).toBe(0);
    expect(report.skipped.map((s) => s.reason).sort()).toEqual(
      [
        'not a credential row',
        'partition key is not the row’s own token',
        'plaintext is not a token of this surface',
      ].sort()
    );
    expect(JSON.stringify(report)).not.toContain(TAG_TOKEN);
    expect(JSON.stringify(report)).not.toContain(other);
    expect(rows.size).toBe(3);
  });

  it('classifyRow refuses an already-hashed row and a row with no plaintext', async () => {
    const { backfill } = await load();
    const surface = backfill.LEGACY_SURFACES.plantTag;
    expect(backfill.classifyRow(surface, { ...legacyTag(), tokenHash: 'x' })).toEqual({
      kind: 'skip',
      reason: 'already hashed',
    });
    expect(backfill.classifyRow(surface, { ...legacyTag(), token: undefined })).toEqual({
      kind: 'skip',
      reason: 'no plaintext on the row',
    });
    expect(backfill.classifyRow(surface, { ...legacyTag(), PK: 'KIOSK#x' })).toEqual({
      kind: 'skip',
      reason: 'not this surface',
    });
  });

  it('only strips `notes` from a share snapshot, and leaves a clean one alone', async () => {
    const { backfill } = await load();
    const scrub = backfill.LEGACY_SURFACES.plantShare.scrub!;
    const clean = { plantSnapshot: { name: 'Pothos', careRule: 'weekly' } };
    expect(scrub(clean)).toBe(clean);
    expect(scrub({ plantSnapshot: { name: 'Pothos', notes: 'private' } })).toEqual({
      plantSnapshot: { name: 'Pothos' },
    });
  });

  it('unchangedCondition pins present values, absent attributes and nulls', async () => {
    const { backfill } = await load();
    const condition = backfill.unchangedCondition(backfill.LEGACY_SURFACES.plantTag, {
      status: 'active',
      revokedAt: null,
      pinFailures: 0,
    });
    expect(condition.ConditionExpression).toBe(
      'attribute_exists(PK) AND #m0 = :m0 AND attribute_type(#m1, :m1) AND ' +
        'attribute_not_exists(#m2) AND #m3 = :m3 AND attribute_not_exists(#m4)'
    );
    expect(condition.ExpressionAttributeNames).toEqual({
      '#m0': 'status',
      '#m1': 'revokedAt',
      '#m2': 'ttl',
      '#m3': 'pinFailures',
      '#m4': 'pinLockedUntil',
    });
    expect(condition.ExpressionAttributeValues).toEqual({
      ':m0': 'active',
      ':m1': 'NULL',
      ':m3': 0,
    });
  });
});
