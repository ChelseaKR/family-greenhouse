import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL = process.env;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.resetModules();
});

afterEach(() => {
  process.env = ORIGINAL;
  vi.unstubAllGlobals();
});

describe('perenual client', () => {
  it('returns null from every method when neither env nor secret is set', async () => {
    process.env = { ...ORIGINAL };
    delete process.env.PERENUAL_API_KEY;
    delete process.env.PERENUAL_API_KEY_SECRET_ID;
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
});
