import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL = process.env;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  process.env = ORIGINAL;
  vi.unstubAllGlobals();
});

describe('plantIdentification', () => {
  it('returns configured:false when PLANT_ID_API_KEY is unset', async () => {
    process.env = { ...ORIGINAL };
    delete process.env.PLANT_ID_API_KEY;
    const { identifyPlant } = await import('../../../src/services/plantIdentification.js');
    const result = await identifyPlant('AAAA');
    expect(result).toEqual({ configured: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards to plant.id when configured and parses suggestions', async () => {
    process.env = { ...ORIGINAL, PLANT_ID_API_KEY: 'k' };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: {
          classification: {
            suggestions: [
              {
                name: 'Monstera deliciosa',
                probability: 0.95,
                details: { common_names: ['Monstera', 'Swiss cheese plant'] },
              },
              { name: 'Philodendron', probability: 0.4 },
            ],
          },
        },
      }),
    });
    const { identifyPlant } = await import('../../../src/services/plantIdentification.js');
    const result = await identifyPlant('AAAA');
    expect(result).toEqual({
      configured: true,
      suggestions: [
        { scientificName: 'Monstera deliciosa', commonName: 'Monstera', probability: 0.95 },
        { scientificName: 'Philodendron', commonName: null, probability: 0.4 },
      ],
    });
  });

  it('throws on non-2xx upstream', async () => {
    process.env = { ...ORIGINAL, PLANT_ID_API_KEY: 'k' };
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => 'overloaded',
    });
    const { identifyPlant } = await import('../../../src/services/plantIdentification.js');
    await expect(identifyPlant('AAAA')).rejects.toThrow(/503/);
  });

  it('passes an abort signal to fetch and aborts after the 5s timeout', async () => {
    process.env = { ...ORIGINAL, PLANT_ID_API_KEY: 'k' };
    vi.useFakeTimers();
    try {
      // Simulate a hung upstream: never resolves, only rejects on abort —
      // exactly how undici surfaces an AbortController firing.
      fetchMock.mockImplementationOnce(
        (_url: string, opts: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            opts.signal.addEventListener('abort', () => {
              const err = new Error('This operation was aborted');
              err.name = 'AbortError';
              reject(err);
            });
          })
      );
      const { identifyPlant } = await import('../../../src/services/plantIdentification.js');
      const pending = identifyPlant('AAAA');
      const assertion = expect(pending).rejects.toThrow(/timed out after 5000ms/);
      await vi.advanceTimersByTimeAsync(5001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not time out a fast upstream response', async () => {
    process.env = { ...ORIGINAL, PLANT_ID_API_KEY: 'k' };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: { classification: { suggestions: [] } } }),
    });
    const { identifyPlant } = await import('../../../src/services/plantIdentification.js');
    await expect(identifyPlant('AAAA')).resolves.toEqual({
      configured: true,
      suggestions: [],
    });
    // The request carried the timeout signal.
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});
