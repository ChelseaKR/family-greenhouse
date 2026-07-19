import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Controllable Parameter Store so we can exercise the resolveApiKey caching
// semantics (transient failure must NOT cache the 'unset' sentinel).
const ssmSend = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: vi.fn(function () {
    return { send: ssmSend };
  }),
  GetParameterCommand: vi.fn(function (input: unknown) {
    return input;
  }),
}));
vi.mock('aws-xray-sdk-core', () => ({
  default: { captureAWSv3Client: (client: unknown) => client },
}));

const ORIGINAL = process.env;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.resetModules();
  ssmSend.mockReset();
});

afterEach(() => {
  process.env = ORIGINAL;
  vi.unstubAllGlobals();
});

describe('perenual client', () => {
  it('returns null from every method when neither env nor parameter is set', async () => {
    process.env = { ...ORIGINAL };
    delete process.env.PERENUAL_API_KEY;
    delete process.env.PERENUAL_API_KEY_PARAMETER_NAME;
    const perenual = await import('../../../src/services/perenual.js');
    perenual.__resetApiKeyForTests();
    expect(await perenual.isConfigured()).toBe(false);
    expect(await perenual.searchSpecies('monstera')).toBeNull();
    expect(await perenual.getSpecies(1)).toBeNull();
    expect(await perenual.getCareGuide(1)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('parses a search response into normalized summaries', async () => {
    process.env = { ...ORIGINAL, PERENUAL_API_KEY: 'k' };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 7,
            common_name: 'Monstera',
            scientific_name: ['Monstera deliciosa'],
            default_image: { thumbnail: 'https://img/thumb.jpg' },
          },
        ],
      }),
    });
    const perenual = await import('../../../src/services/perenual.js');
    const out = await perenual.searchSpecies('mons');
    expect(out).toEqual([
      {
        id: 7,
        commonName: 'Monstera',
        scientificName: 'Monstera deliciosa',
        thumbnailUrl: 'https://img/thumb.jpg',
      },
    ]);
  });

  it('returns null on non-2xx responses (callers degrade gracefully)', async () => {
    process.env = { ...ORIGINAL, PERENUAL_API_KEY: 'k' };
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) });
    const perenual = await import('../../../src/services/perenual.js');
    expect(await perenual.searchSpecies('x')).toBeNull();
  });

  it('returns null when fetch throws (timeout, DNS, etc.)', async () => {
    process.env = { ...ORIGINAL, PERENUAL_API_KEY: 'k' };
    fetchMock.mockRejectedValueOnce(new Error('ETIMEDOUT'));
    const perenual = await import('../../../src/services/perenual.js');
    expect(await perenual.getSpecies(99)).toBeNull();
  });

  it('retries parameter resolution after a transient Parameter Store failure', async () => {
    process.env = { ...ORIGINAL, PERENUAL_API_KEY_PARAMETER_NAME: '/app/perenual-key' };
    delete process.env.PERENUAL_API_KEY;
    const perenual = await import('../../../src/services/perenual.js');
    perenual.__resetApiKeyForTests();

    // First call: Parameter Store throttles. The integration must degrade
    // for THIS call only — not cache 'unset' for the container lifetime.
    ssmSend.mockRejectedValueOnce(new Error('ThrottlingException'));
    expect(await perenual.isConfigured()).toBe(false);

    // Next call (same warm container, NO test reset): fetch succeeds and
    // the integration comes back.
    ssmSend.mockResolvedValueOnce({ Parameter: { Value: 'real-key' } });
    expect(await perenual.isConfigured()).toBe(true);
    expect(ssmSend).toHaveBeenCalledTimes(2);
  });

  it('falls back to the env literal when the parameter fetch fails transiently', async () => {
    process.env = {
      ...ORIGINAL,
      PERENUAL_API_KEY_PARAMETER_NAME: '/app/perenual-key',
      PERENUAL_API_KEY: 'literal-key',
    };
    const perenual = await import('../../../src/services/perenual.js');
    perenual.__resetApiKeyForTests();

    ssmSend.mockRejectedValueOnce(new Error('network'));
    expect(await perenual.isConfigured()).toBe(true);
  });

  it('caches the unset sentinel only for a genuinely empty parameter', async () => {
    process.env = { ...ORIGINAL, PERENUAL_API_KEY_PARAMETER_NAME: '/app/perenual-key' };
    delete process.env.PERENUAL_API_KEY;
    const perenual = await import('../../../src/services/perenual.js');
    perenual.__resetApiKeyForTests();

    // Deliberately blank parameter: cache 'unset' and don't re-fetch.
    ssmSend.mockResolvedValue({ Parameter: { Value: '   ' } });
    expect(await perenual.isConfigured()).toBe(false);
    expect(await perenual.isConfigured()).toBe(false);
    expect(ssmSend).toHaveBeenCalledTimes(1);
  });

  it('normalizes species detail watering enum and pet toxicity', async () => {
    process.env = { ...ORIGINAL, PERENUAL_API_KEY: 'k' };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 12,
        common_name: 'Pothos',
        scientific_name: ['Epipremnum aureum'],
        family: 'Araceae',
        cycle: 'Perennial',
        watering: 'Average',
        sunlight: ['part shade'],
        hardiness: { min: '10', max: '12' },
        indoor: true,
        edible_fruit: false,
        poisonous_to_pets: 1,
        default_image: { original_url: 'https://img/full.jpg' },
      }),
    });
    const perenual = await import('../../../src/services/perenual.js');
    const detail = await perenual.getSpecies(12);
    expect(detail).toEqual({
      id: 12,
      commonName: 'Pothos',
      scientificName: 'Epipremnum aureum',
      thumbnailUrl: null,
      family: 'Araceae',
      cycle: 'Perennial',
      watering: 'average',
      sunlight: ['part shade'],
      hardinessZone: '10-12',
      indoor: true,
      edible: false,
      poisonousToPets: true,
      defaultImageUrl: 'https://img/full.jpg',
    });
  });

  it('trims whitespace before matching the watering enum', async () => {
    process.env = { ...ORIGINAL, PERENUAL_API_KEY: 'k' };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 1,
        common_name: 'Test',
        scientific_name: 'Testus testus',
        watering: '  Average  ',
        poisonous_to_pets: null,
      }),
    });
    const perenual = await import('../../../src/services/perenual.js');
    const detail = await perenual.getSpecies(1);
    expect(detail?.watering).toBe('average');
  });

  it('distinguishes confirmed non-toxic (false/0) from unknown (null/undefined) pet toxicity', async () => {
    process.env = { ...ORIGINAL, PERENUAL_API_KEY: 'k' };
    const perenual = await import('../../../src/services/perenual.js');

    const responseWith = (poisonous_to_pets: unknown) => ({
      ok: true,
      json: async () => ({
        id: 1,
        common_name: 'Test',
        scientific_name: 'Testus testus',
        poisonous_to_pets,
      }),
    });

    fetchMock.mockResolvedValueOnce(responseWith(false));
    expect((await perenual.getSpecies(1))?.poisonousToPets).toBe(false);

    fetchMock.mockResolvedValueOnce(responseWith(0));
    expect((await perenual.getSpecies(1))?.poisonousToPets).toBe(false);

    fetchMock.mockResolvedValueOnce(responseWith(1));
    expect((await perenual.getSpecies(1))?.poisonousToPets).toBe(true);

    // The Cinnamomum-cassia-shaped case: Perenual simply has no data. Must
    // NOT collapse to `false` ("confirmed non-toxic") — that would be a
    // guess dressed up as a fact, exactly like the already-fixed watering bug.
    fetchMock.mockResolvedValueOnce(responseWith(null));
    expect((await perenual.getSpecies(1))?.poisonousToPets).toBeNull();

    fetchMock.mockResolvedValueOnce(responseWith(undefined));
    expect((await perenual.getSpecies(1))?.poisonousToPets).toBeNull();
  });

  it('falls back to the scientific name when Perenual omits common_name', async () => {
    process.env = { ...ORIGINAL, PERENUAL_API_KEY: 'k' };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 3,
            common_name: null,
            scientific_name: ['Cinnamomum cassia'],
          },
        ],
      }),
    });
    const perenual = await import('../../../src/services/perenual.js');
    const out = await perenual.searchSpecies('cassia');
    // Must be a usable string, never null — a null commonName crashes any
    // caller that calls .toLowerCase() on it (e.g. the species combobox).
    expect(out?.[0].commonName).toBe('Cinnamomum cassia');
  });

  it('returns an empty care guide instead of throwing when Perenual omits section data', async () => {
    process.env = { ...ORIGINAL, PERENUAL_API_KEY: 'k' };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ id: 1, species_id: 5 }], // no `section` field at all
      }),
    });
    const perenual = await import('../../../src/services/perenual.js');
    // The module's own contract is "never throws" — a malformed upstream
    // response must degrade to an empty guide, not a 500.
    await expect(perenual.getCareGuide(5)).resolves.toEqual({ speciesId: 5, sections: [] });
  });

  it('distinguishes a genuinely empty care guide (cacheable) from a failed request (not cacheable)', async () => {
    process.env = { ...ORIGINAL, PERENUAL_API_KEY: 'k' };
    const perenual = await import('../../../src/services/perenual.js');

    // Perenual answered successfully, but has no guide at all for this
    // species — a real, cacheable answer (mirrors searchSpecies's `[]`).
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) });
    await expect(perenual.getCareGuide(5)).resolves.toEqual({ speciesId: 5, sections: [] });

    // The request itself failed — must stay null so the caller doesn't
    // cache a transient failure as if it were a confirmed empty guide.
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    await expect(perenual.getCareGuide(5)).resolves.toBeNull();
  });
});
