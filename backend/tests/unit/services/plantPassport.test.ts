/**
 * Plant passport service (#676): what is written when a link is made, how a
 * stored block is read back, and the once-per-household claim behind the
 * import.
 *
 * DynamoDB is faked at the client boundary so the tests see the exact commands
 * the service builds — the row a stranger's link resolves to, and the
 * conditions that make a replay lose.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { scryptSync } from 'node:crypto';

/** The production digest of a share code (the same restatement plantShare.test.ts pins). */
function digest(code: string): string {
  return scryptSync(code, 'family-greenhouse-plantshare-v1', 32).toString('hex');
}

vi.mock('@aws-sdk/lib-dynamodb', () => {
  const command = (kind: string) =>
    vi.fn(function (input) {
      return { input, kind };
    });
  return {
    PutCommand: command('Put'),
    GetCommand: command('Get'),
    QueryCommand: command('Query'),
    DeleteCommand: command('Delete'),
    UpdateCommand: command('Update'),
    BatchWriteCommand: command('BatchWrite'),
    TransactWriteCommand: command('TransactWrite'),
  };
});
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(function () {
    return { send: vi.fn() };
  }),
  ListObjectsV2Command: vi.fn(function (input) {
    return { input };
  }),
  DeleteObjectsCommand: vi.fn(function (input) {
    return { input };
  }),
}));
vi.mock('../../../src/utils/dynamodb', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));
vi.mock('../../../src/services/taskService.js');

type Sent = { kind: string; input: Record<string, unknown> };

const NOW = new Date('2026-09-19T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const plantRow = {
  id: 'plant-1',
  householdId: 'hh-1',
  name: 'Mother Monstera',
  species: 'Monstera deliciosa',
  speciesSource: 'identified',
  imageUrl: 'https://assets.example/plants/hh-1/plant-1/a.jpg',
  notes: 'PRIVATENOTE-9Z spare key is under the flowerpot',
  careRule: 'bottom-water only',
  placementNote: 'PRIVATEPLACEMENT-2Q behind the boiler',
  status: 'gave_away',
  tags: ['tropical'],
  parentPlantId: 'plant-0',
  createdAt: daysAgo(400),
  createdBy: 'user-1',
  updatedAt: daysAgo(1),
};
const parentRow = { ...plantRow, id: 'plant-0', name: 'Kitchen Pothos', parentPlantId: null };
const childRow = { ...plantRow, id: 'plant-2', name: 'Baby Monstera', parentPlantId: 'plant-1' };

/** Route each command to a canned answer; record every Put. */
async function fakeTable(rows: { plant?: unknown; plants?: unknown[] } = {}) {
  const { dynamodb } = await import('../../../src/utils/dynamodb');
  const puts: Sent[] = [];
  vi.mocked(dynamodb.send).mockImplementation((async (cmd: Sent) => {
    if (cmd.kind === 'Put') {
      puts.push(cmd);
      return {};
    }
    if (cmd.kind === 'Get') return { Item: rows.plant ?? plantRow };
    if (cmd.kind === 'Query') return { Items: rows.plants ?? [plantRow, parentRow, childRow] };
    return {};
  }) as never);
  return puts;
}

async function primeTaskReads() {
  const taskService = await import('../../../src/services/taskService.js');
  vi.mocked(taskService.getTasksForPlant).mockResolvedValue([
    {
      id: 'task-1',
      householdId: 'hh-1',
      plantId: 'plant-1',
      plantName: 'Mother Monstera',
      type: 'water',
      customType: null,
      frequency: 7,
      seasonalCadences: [{ season: 'winter', frequency: 14 }],
      lastCompleted: daysAgo(3),
      nextDue: daysAgo(-4),
      assignedTo: 'user-secret',
      assignedToName: 'Secret Person',
      notes: 'PRIVATETASK-7L water from the rain barrel',
    },
  ] as never);
  vi.mocked(taskService.getTaskCompletions).mockResolvedValue([
    {
      id: 'c-1',
      completedAt: daysAgo(3),
      completedByName: 'Secret Person',
      completedBy: 'user-secret',
      notes: 'PRIVATECOMPLETION-5K',
    },
    { id: 'c-2', completedAt: daysAgo(20), completedByName: 'Secret Person', notes: null },
  ] as never);
  return taskService;
}

describe('createPassportShare', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('freezes a summary derived from stored records onto the share row', async () => {
    const puts = await fakeTable();
    const taskService = await primeTaskReads();
    const { createPassportShare } = await import('../../../src/services/plantPassport.js');

    const share = await createPassportShare('hh-1', 'plant-1', 'user-1', NOW);

    expect(share).not.toBeNull();
    // Read by the CALLER's household id and this plant id — nothing else.
    expect(taskService.getTasksForPlant).toHaveBeenCalledWith('hh-1', 'plant-1');
    expect(taskService.getTaskCompletions).toHaveBeenCalledWith('hh-1', 'plant-1', 100);

    expect(puts).toHaveLength(1);
    const item = puts[0].input.Item as Record<string, unknown>;
    expect(item.PK).toBe(`SHARE#${digest(share!.code)}`);
    expect(item.entityType).toBe('PlantShare');
    expect(item.passport).toEqual({
      version: 1,
      speciesSource: 'identified',
      inHouseholdSince: daysAgo(400).slice(0, 10),
      schedule: [
        {
          type: 'water',
          customType: null,
          frequency: 7,
          seasonal: [{ season: 'winter', frequency: 14 }],
        },
      ],
      scheduleMore: 0,
      care: {
        windowDays: 90,
        loggedInWindow: 2,
        atLeast: false,
        addedWithinWindow: false,
        lastLoggedOn: daysAgo(3).slice(0, 10),
      },
      lineage: { parentName: 'Kitchen Pothos', cuttingsTaken: 1 },
    });
    // The card is exactly what a cutting link freezes.
    expect(item.plantSnapshot).toEqual({
      name: 'Mother Monstera',
      species: 'Monstera deliciosa',
      careRule: 'bottom-water only',
      imageUrl: 'https://assets.example/plants/hh-1/plant-1/a.jpg',
      tags: ['tropical'],
    });
  });

  it('lets none of the household’s private words, ids or people reach the stored row', async () => {
    const puts = await fakeTable();
    await primeTaskReads();
    const { createPassportShare } = await import('../../../src/services/plantPassport.js');

    const share = await createPassportShare('hh-1', 'plant-1', 'user-1', NOW);

    const stored = JSON.stringify(puts[0].input.Item);
    for (const secret of [
      'PRIVATENOTE-9Z',
      'PRIVATEPLACEMENT-2Q',
      'PRIVATETASK-7L',
      'PRIVATECOMPLETION-5K',
      'Secret Person',
      'user-secret',
      'plant-0',
      'plant-2',
      'task-1',
      // The plaintext credential never sits in the row (#450).
      share!.code,
    ]) {
      expect(stored).not.toContain(secret);
    }
    // Ids appear only where a link needs them: the share's own owner fields.
    const item = puts[0].input.Item as Record<string, unknown>;
    expect(JSON.stringify(item.passport)).not.toMatch(/hh-1|user-1|plant-1/);
  });

  it('is null, with nothing written, for a plant outside the household', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb');
    vi.mocked(dynamodb.send).mockResolvedValue({ Item: undefined } as never);
    const { createPassportShare } = await import('../../../src/services/plantPassport.js');
    expect(await createPassportShare('hh-1', 'nope', 'user-1', NOW)).toBeNull();
    const kinds = vi.mocked(dynamodb.send).mock.calls.map(([c]) => (c as unknown as Sent).kind);
    expect(kinds).not.toContain('Put');
  });

  it('writes nothing when a history read fails, rather than freezing a partial passport', async () => {
    const puts = await fakeTable();
    const taskService = await primeTaskReads();
    vi.mocked(taskService.getTaskCompletions).mockRejectedValueOnce(new Error('throttled'));
    const { createPassportShare } = await import('../../../src/services/plantPassport.js');
    await expect(createPassportShare('hh-1', 'plant-1', 'user-1', NOW)).rejects.toThrow(
      'throttled'
    );
    expect(puts).toHaveLength(0);
  });

  it('leaves a plain cutting link’s row exactly as it was (no passport attribute)', async () => {
    const puts = await fakeTable();
    const { createPlantShare } = await import('../../../src/services/plantService.js');
    await createPlantShare('hh-1', 'plant-1', 'user-1');
    const item = puts[0].input.Item as Record<string, unknown>;
    expect('passport' in item).toBe(false);
  });
});

describe('getPlantShare — the stored passport block is untrusted', () => {
  const code = 'b'.repeat(32);
  const good = {
    version: 1,
    speciesSource: null,
    inHouseholdSince: '2025-01-01',
    schedule: [],
    scheduleMore: 0,
    care: {
      windowDays: 90,
      loggedInWindow: 0,
      atLeast: false,
      addedWithinWindow: false,
      lastLoggedOn: null,
    },
    lineage: { parentName: null, cuttingsTaken: 0 },
  };

  async function readWith(passport: unknown) {
    const { dynamodb } = await import('../../../src/utils/dynamodb');
    vi.mocked(dynamodb.send).mockResolvedValue({
      Item: {
        PK: `SHARE#${digest(code)}`,
        SK: 'METADATA',
        plantId: 'plant-1',
        householdId: 'hh-1',
        plantSnapshot: { name: 'Fern', species: null, careRule: null, imageUrl: null, tags: [] },
        ...(passport === undefined ? {} : { passport }),
        createdBy: 'user-1',
        createdAt: daysAgo(1),
        expiresAt: daysAgo(-13),
      },
    } as never);
    const { getPlantShare } = await import('../../../src/services/plantService.js');
    return getPlantShare(code);
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a well-formed block', async () => {
    expect((await readWith(good))?.passport).toEqual(good);
  });

  it('reads a cutting link (no block) as no passport', async () => {
    expect((await readWith(undefined))?.passport).toBeNull();
  });

  it.each([
    ['a smuggled notes key', { ...good, notes: 'PRIVATE' }],
    ['a smuggled household id', { ...good, householdId: 'hh-victim' }],
    ['a string', 'PRIVATE'],
    ['an oversize schedule', { ...good, schedule: Array.from({ length: 11 }, () => ({})) }],
    ['a wrong version', { ...good, version: 9 }],
  ])('reads %s as no passport and still serves the plain card', async (_label, block) => {
    const share = await readWith(block);
    expect(share).not.toBeNull();
    expect(share?.passport).toBeNull();
    expect(share?.plantSnapshot.name).toBe('Fern');
  });
});

describe('claimPassportImport — once per household per link', () => {
  const code = 'c'.repeat(32);
  const expiresAt = daysAgo(-10);
  const conditionFailed = () =>
    Object.assign(new Error('nope'), { name: 'ConditionalCheckFailedException' });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function send() {
    const { dynamodb } = await import('../../../src/utils/dynamodb');
    return vi.mocked(dynamodb.send);
  }

  it('takes the claim with one conditional Put in the RECIPIENT household', async () => {
    const sendMock = await send();
    sendMock.mockResolvedValue({} as never);
    const { claimPassportImport } = await import('../../../src/services/plantPassport.js');

    expect(await claimPassportImport('hh-recipient', code, expiresAt, NOW)).toEqual({
      kind: 'claimed',
    });

    const put = sendMock.mock.calls[0][0] as unknown as Sent;
    expect(put.kind).toBe('Put');
    expect(put.input.ConditionExpression).toBe('attribute_not_exists(PK)');
    const item = put.input.Item as Record<string, unknown>;
    expect(item.PK).toBe('HOUSEHOLD#hh-recipient');
    // Keyed by the digest, never the code, and never in the sharer's partition.
    expect(item.SK).toBe(`PASSPORTIMPORT#${digest(code)}`);
    expect(JSON.stringify(item)).not.toContain(code);
    expect(JSON.stringify(item)).not.toContain('hh-source');
    // Expires with the link, so it is gone when the link is.
    expect(item.ttl).toBe(Math.floor(new Date(expiresAt).getTime() / 1000));
  });

  it('answers a replay with the plant the first import made', async () => {
    const sendMock = await send();
    sendMock
      .mockRejectedValueOnce(conditionFailed())
      .mockResolvedValueOnce({ Item: { plantId: 'plant-new', claimedAt: daysAgo(1) } } as never)
      // the plant still exists in the recipient household
      .mockResolvedValueOnce({
        Item: { ...plantRow, id: 'plant-new', householdId: 'hh-recipient' },
      } as never);
    const { claimPassportImport } = await import('../../../src/services/plantPassport.js');

    expect(await claimPassportImport('hh-recipient', code, expiresAt, NOW)).toEqual({
      kind: 'already',
      plantId: 'plant-new',
    });
    // Two failures' worth of reads, and no second write.
    const kinds = sendMock.mock.calls.map(([c]) => (c as unknown as Sent).kind);
    expect(kinds.filter((k) => k === 'Put')).toHaveLength(1);
  });

  it('treats a claim that is still running as a repeat, not a chance to import twice', async () => {
    const sendMock = await send();
    sendMock.mockRejectedValueOnce(conditionFailed()).mockResolvedValueOnce({
      Item: { claimedAt: new Date(NOW.getTime() - 5_000).toISOString() },
    } as never);
    const { claimPassportImport } = await import('../../../src/services/plantPassport.js');
    expect(await claimPassportImport('hh-recipient', code, expiresAt, NOW)).toEqual({
      kind: 'already',
      plantId: null,
    });
  });

  it('takes over a claim whose first import died before finishing', async () => {
    const stale = new Date(NOW.getTime() - 10 * 60_000).toISOString();
    const sendMock = await send();
    sendMock
      .mockRejectedValueOnce(conditionFailed())
      .mockResolvedValueOnce({ Item: { claimedAt: stale } } as never)
      .mockResolvedValueOnce({} as never);
    const { claimPassportImport } = await import('../../../src/services/plantPassport.js');

    expect(await claimPassportImport('hh-recipient', code, expiresAt, NOW)).toEqual({
      kind: 'claimed',
    });
    const takeover = sendMock.mock.calls[2][0] as unknown as Sent;
    // Compare-and-swap on exactly the stale record.
    expect(takeover.input.ConditionExpression).toBe(
      'attribute_not_exists(plantId) AND claimedAt = :stale'
    );
    expect(takeover.input.ExpressionAttributeValues).toEqual({ ':stale': stale });
  });

  it('lets a household re-import after it deleted its copy, by swapping the exact stale record', async () => {
    const sendMock = await send();
    sendMock
      .mockRejectedValueOnce(conditionFailed())
      .mockResolvedValueOnce({ Item: { plantId: 'plant-gone', claimedAt: daysAgo(2) } } as never)
      .mockResolvedValueOnce({ Item: undefined } as never) // getPlant: gone
      .mockResolvedValueOnce({} as never);
    const { claimPassportImport } = await import('../../../src/services/plantPassport.js');

    expect(await claimPassportImport('hh-recipient', code, expiresAt, NOW)).toEqual({
      kind: 'claimed',
    });
    const swap = sendMock.mock.calls[3][0] as unknown as Sent;
    expect(swap.input.ConditionExpression).toBe('plantId = :stale');
    expect(swap.input.ExpressionAttributeValues).toEqual({ ':stale': 'plant-gone' });
  });

  it('loses cleanly when two replays race to take over the same stale record', async () => {
    const sendMock = await send();
    sendMock
      .mockRejectedValueOnce(conditionFailed())
      .mockResolvedValueOnce({ Item: { plantId: 'plant-gone', claimedAt: daysAgo(2) } } as never)
      .mockResolvedValueOnce({ Item: undefined } as never)
      .mockRejectedValueOnce(conditionFailed());
    const { claimPassportImport } = await import('../../../src/services/plantPassport.js');
    expect(await claimPassportImport('hh-recipient', code, expiresAt, NOW)).toEqual({
      kind: 'already',
      plantId: null,
    });
  });

  it('propagates a real failure instead of reading it as a repeat', async () => {
    const sendMock = await send();
    sendMock.mockRejectedValueOnce(new Error('ProvisionedThroughputExceeded'));
    const { claimPassportImport } = await import('../../../src/services/plantPassport.js');
    await expect(claimPassportImport('hh-recipient', code, expiresAt, NOW)).rejects.toThrow(
      'ProvisionedThroughputExceeded'
    );
  });
});

describe('recordPassportImport / releasePassportImport', () => {
  const code = 'd'.repeat(32);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('points the claim at the plant it produced', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb');
    vi.mocked(dynamodb.send).mockResolvedValue({} as never);
    const { recordPassportImport } = await import('../../../src/services/plantPassport.js');
    await recordPassportImport('hh-recipient', code, 'plant-new');
    const update = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as Sent;
    expect(update.kind).toBe('Update');
    expect(update.input.Key).toEqual({
      PK: 'HOUSEHOLD#hh-recipient',
      SK: `PASSPORTIMPORT#${digest(code)}`,
    });
    expect(update.input.ExpressionAttributeValues).toEqual({ ':plantId': 'plant-new' });
  });

  it('does not fail an import that succeeded because its pointer could not be written', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb');
    vi.mocked(dynamodb.send).mockRejectedValue(new Error('throttled'));
    const { recordPassportImport } = await import('../../../src/services/plantPassport.js');
    await expect(recordPassportImport('hh-recipient', code, 'plant-new')).resolves.toBeUndefined();
  });

  it('gives back only an UNFINISHED claim', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb');
    vi.mocked(dynamodb.send).mockResolvedValue({} as never);
    const { releasePassportImport } = await import('../../../src/services/plantPassport.js');
    await releasePassportImport('hh-recipient', code);
    const del = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as Sent;
    expect(del.kind).toBe('Delete');
    expect(del.input.ConditionExpression).toBe('attribute_not_exists(plantId)');
  });

  it('leaves a finished claim alone when the condition refuses the delete', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb');
    vi.mocked(dynamodb.send).mockRejectedValue(
      Object.assign(new Error('done'), { name: 'ConditionalCheckFailedException' })
    );
    const { releasePassportImport } = await import('../../../src/services/plantPassport.js');
    await expect(releasePassportImport('hh-recipient', code)).resolves.toBeUndefined();
  });
});
