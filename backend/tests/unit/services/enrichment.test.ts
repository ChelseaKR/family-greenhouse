import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/services/perenual.js');
vi.mock('@aws-sdk/lib-dynamodb', () => ({
  GetCommand: vi.fn(function (input: unknown) {
    return { input, kind: 'Get' };
  }),
  PutCommand: vi.fn(function (input: unknown) {
    return { input, kind: 'Put' };
  }),
  UpdateCommand: vi.fn(function (input: unknown) {
    return { input, kind: 'Update' };
  }),
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));

import * as perenual from '../../../src/services/perenual.js';
import { dynamodb } from '../../../src/utils/dynamodb.js';
import {
  searchSpeciesCached,
  getSpeciesCached,
  getCareGuideCached,
  listPestsForSpeciesCached,
} from '../../../src/services/enrichment.js';

interface Cmd {
  input: { Key?: { PK: string; SK: string }; Item?: Record<string, unknown> };
  kind: string;
}

const ORIGINAL = process.env;

const summary = [
  { id: 7, commonName: 'Monstera', scientificName: 'M. deliciosa', thumbnailUrl: null },
];

/** dynamodb.send dispatcher: Get → cache row, Update → budget counter, Put → ack. */
function stubDynamo(opts: {
  cacheItem?: Record<string, unknown> | null;
  budgetUsed?: number;
  getRejects?: boolean;
  updateRejects?: boolean;
  putRejects?: boolean;
}) {
  vi.mocked(dynamodb.send).mockImplementation((async (cmd: Cmd) => {
    switch (cmd.kind) {
      case 'Get':
        if (opts.getRejects) throw new Error('ddb get throttled');
        return { Item: opts.cacheItem ?? undefined };
      case 'Update':
        if (opts.updateRejects) throw new Error('ddb update throttled');
        return { Attributes: { used: opts.budgetUsed ?? 1 } };
      case 'Put':
        if (opts.putRejects) throw new Error('ddb put throttled');
        return {};
      default:
        throw new Error(`unexpected command ${cmd.kind}`);
    }
  }) as never);
}

function sentCommands(): Cmd[] {
  return vi.mocked(dynamodb.send).mock.calls.map((c) => c[0] as unknown as Cmd);
}

describe('enrichment (Perenual cache + budget breaker)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...ORIGINAL };
    delete process.env.PERENUAL_DAILY_BUDGET;
    vi.mocked(perenual.isConfigured).mockResolvedValue(true);
  });

  afterEach(() => {
    process.env = ORIGINAL;
  });

  it('returns null from every method when Perenual is unconfigured (no DDB traffic)', async () => {
    vi.mocked(perenual.isConfigured).mockResolvedValue(false);
    expect(await searchSpeciesCached('monstera')).toBeNull();
    expect(await getSpeciesCached(7)).toBeNull();
    expect(await getCareGuideCached(7)).toBeNull();
    expect(await listPestsForSpeciesCached('Monstera deliciosa')).toEqual({
      ok: false,
      reason: 'unconfigured',
    });
    expect(dynamodb.send).not.toHaveBeenCalled();
  });

  it('returns [] for a blank search query without touching cache or API', async () => {
    expect(await searchSpeciesCached('   ')).toEqual([]);
    expect(dynamodb.send).not.toHaveBeenCalled();
    expect(perenual.searchSpecies).not.toHaveBeenCalled();
  });

  describe('cache hit', () => {
    it('serves search from cache: no budget spend, no upstream call', async () => {
      stubDynamo({ cacheItem: { payload: summary } });

      const out = await searchSpeciesCached('Monstera');
      expect(out).toEqual(summary);
      expect(perenual.searchSpecies).not.toHaveBeenCalled();

      const cmds = sentCommands();
      expect(cmds).toHaveLength(1); // exactly the Get — budget counter untouched
      expect(cmds[0].kind).toBe('Get');
      // Cache key is normalized (trimmed + lowercased query).
      expect(cmds[0].input.Key).toEqual({ PK: 'PERENUAL#CACHE', SK: 'SEARCH#monstera' });
    });

    it('treats an expired-TTL row as a miss and refetches', async () => {
      const expired = {
        payload: summary,
        ttl: Math.floor(Date.now() / 1000) - 10,
      };
      stubDynamo({ cacheItem: expired });
      vi.mocked(perenual.searchSpecies).mockResolvedValue(summary as never);

      const out = await searchSpeciesCached('monstera');
      expect(out).toEqual(summary);
      expect(perenual.searchSpecies).toHaveBeenCalledWith('monstera');
    });
  });

  describe('cache miss', () => {
    it('spends budget, calls Perenual, and writes the result back with a TTL', async () => {
      stubDynamo({ cacheItem: null, budgetUsed: 5 });
      vi.mocked(perenual.getSpecies).mockResolvedValue({ id: 7 } as never);

      const out = await getSpeciesCached(7);
      expect(out).toEqual({ id: 7 });

      const kinds = sentCommands().map((c) => c.kind);
      expect(kinds).toEqual(['Get', 'Update', 'Put']);

      const put = sentCommands()[2];
      expect(put.input.Item).toMatchObject({
        PK: 'PERENUAL#CACHE',
        SK: 'SPECIES#7',
        entityType: 'PerenualCache',
        payload: { id: 7 },
      });
      expect(put.input.Item!.ttl as number).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('does not cache an upstream null (next request retries)', async () => {
      stubDynamo({ cacheItem: null, budgetUsed: 1 });
      vi.mocked(perenual.getCareGuide).mockResolvedValue(null as never);

      expect(await getCareGuideCached(9)).toBeNull();
      const kinds = sentCommands().map((c) => c.kind);
      expect(kinds).toEqual(['Get', 'Update']); // no Put
    });
  });

  describe('daily-budget circuit breaker', () => {
    it('blocks the upstream call once usage exceeds the budget', async () => {
      process.env.PERENUAL_DAILY_BUDGET = '10';
      stubDynamo({ cacheItem: null, budgetUsed: 11 });

      expect(await searchSpeciesCached('monstera')).toBeNull();
      expect(perenual.searchSpecies).not.toHaveBeenCalled();
    });

    it('allows the call right at the budget boundary (used == limit)', async () => {
      process.env.PERENUAL_DAILY_BUDGET = '10';
      stubDynamo({ cacheItem: null, budgetUsed: 10 });
      vi.mocked(perenual.searchSpecies).mockResolvedValue(summary as never);

      expect(await searchSpeciesCached('monstera')).toEqual(summary);
    });

    it('falls back to the default budget (80) when the env var is garbage', async () => {
      process.env.PERENUAL_DAILY_BUDGET = 'not-a-number';
      stubDynamo({ cacheItem: null, budgetUsed: 81 });

      expect(await getSpeciesCached(7)).toBeNull();
      expect(perenual.getSpecies).not.toHaveBeenCalled();
    });

    it('FAILS OPEN when the budget counter itself errors: the call proceeds', async () => {
      stubDynamo({ cacheItem: null, updateRejects: true });
      vi.mocked(perenual.searchSpecies).mockResolvedValue(summary as never);

      const out = await searchSpeciesCached('monstera');
      expect(out).toEqual(summary);
      expect(perenual.searchSpecies).toHaveBeenCalledTimes(1);
    });
  });

  describe('cache-layer failures degrade, never throw', () => {
    it('a cache-read failure is treated as a miss', async () => {
      stubDynamo({ getRejects: true, budgetUsed: 1 });
      vi.mocked(perenual.searchSpecies).mockResolvedValue(summary as never);

      expect(await searchSpeciesCached('monstera')).toEqual(summary);
    });

    it('a cache-write failure still returns the fresh result', async () => {
      stubDynamo({ cacheItem: null, budgetUsed: 1, putRejects: true });
      vi.mocked(perenual.getSpecies).mockResolvedValue({ id: 7 } as never);

      expect(await getSpeciesCached(7)).toEqual({ id: 7 });
    });
  });

  it('pest lookups key the cache on the trimmed, lowercased scientific name', async () => {
    stubDynamo({ cacheItem: { payload: [] } });
    expect(await listPestsForSpeciesCached('  Monstera Deliciosa  ')).toEqual({
      ok: true,
      pests: [],
    });
    expect(sentCommands()[0].input.Key).toEqual({
      PK: 'PERENUAL#CACHE',
      SK: 'PESTS#monstera deliciosa',
    });
  });

  describe('listPestsForSpeciesCached (distinguishes "no data" from "confirmed no pests")', () => {
    it('reports budget_exhausted distinctly from a genuinely empty pest list', async () => {
      process.env.PERENUAL_DAILY_BUDGET = '10';
      stubDynamo({ cacheItem: null, budgetUsed: 11 });

      expect(await listPestsForSpeciesCached('Monstera deliciosa')).toEqual({
        ok: false,
        reason: 'budget_exhausted',
      });
    });

    it('reports upstream_error when the Perenual call itself fails', async () => {
      stubDynamo({ cacheItem: null, budgetUsed: 1 });
      vi.mocked(perenual.listPestsForSpecies).mockResolvedValue(null as never);

      expect(await listPestsForSpeciesCached('Monstera deliciosa')).toEqual({
        ok: false,
        reason: 'upstream_error',
      });
    });

    it('caches and returns a genuinely empty pest list as ok:true', async () => {
      stubDynamo({ cacheItem: null, budgetUsed: 1 });
      vi.mocked(perenual.listPestsForSpecies).mockResolvedValue([] as never);

      expect(await listPestsForSpeciesCached('Monstera deliciosa')).toEqual({
        ok: true,
        pests: [],
      });
      const kinds = sentCommands().map((c) => c.kind);
      expect(kinds).toEqual(['Get', 'Update', 'Put']); // the empty result IS cached
    });
  });
});
