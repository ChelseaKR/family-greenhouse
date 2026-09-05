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
      confidenceFloor: 0.3,
      lowConfidence: false,
    });
  });

  it('throws a generic error on non-2xx upstream (does NOT reflect the upstream body — L2)', async () => {
    process.env = { ...ORIGINAL, PLANT_ID_API_KEY: 'k' };
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => 'overloaded: secret upstream detail',
    });
    const { identifyPlant } = await import('../../../src/services/plantIdentification.js');
    // The thrown message is generic — neither the status code nor the upstream
    // body leaks to the client (the identify handler exposes 5xx messages).
    await expect(identifyPlant('AAAA')).rejects.toThrow(
      /plant identification service is temporarily unavailable/
    );
    await expect(
      (async () => {
        fetchMock.mockResolvedValueOnce({
          ok: false,
          status: 503,
          text: async () => 'overloaded: secret upstream detail',
        });
        return identifyPlant('AAAA');
      })()
    ).rejects.not.toThrow(/secret upstream detail/);
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
      confidenceFloor: 0.3,
      lowConfidence: false,
    });
    // The request carried the timeout signal.
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
  // --- Ordering (#344) -----------------------------------------------------
  //
  // The `.slice(0, 5)` this covers used to run straight off the provider's
  // array. Plant.id documents no ordering guarantee, so that quietly assumed
  // one; when the assumption is wrong the best match is thrown away and the
  // user is handed a worse guess as the headline. The response below is
  // deliberately NOT sorted, and the true best match is sixth.
  it('sorts candidates by probability before truncating, so an unsorted provider response keeps its best match', async () => {
    process.env = { ...ORIGINAL, PLANT_ID_API_KEY: 'k' };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: {
          classification: {
            suggestions: [
              { name: 'Pothos', probability: 0.11 },
              { name: 'Philodendron', probability: 0.55 },
              { name: 'Dieffenbachia', probability: 0.09 },
              { name: 'Alocasia', probability: 0.22 },
              { name: 'Calathea', probability: 0.07 },
              // Sixth in the provider's order, best by probability. A blind
              // slice(0, 5) drops this one entirely.
              { name: 'Monstera deliciosa', probability: 0.93 },
              { name: 'Ficus lyrata', probability: 0.02 },
            ],
          },
        },
      }),
    });
    const { identifyPlant } = await import('../../../src/services/plantIdentification.js');
    const result = await identifyPlant('AAAA');
    if (!result.configured) throw new Error('expected a configured result');
    expect(result.suggestions.map((s) => s.scientificName)).toEqual([
      'Monstera deliciosa',
      'Philodendron',
      'Alocasia',
      'Pothos',
      'Dieffenbachia',
    ]);
    // The headline is the real best match, not the provider's first row.
    expect(result.suggestions[0].probability).toBe(0.93);
    expect(result.lowConfidence).toBe(false);
  });

  it('keeps provider order among equal probabilities (stable sort)', async () => {
    process.env = { ...ORIGINAL, PLANT_ID_API_KEY: 'k' };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: {
          classification: {
            suggestions: [
              { name: 'First', probability: 0.5 },
              { name: 'Second', probability: 0.5 },
              { name: 'Third', probability: 0.5 },
            ],
          },
        },
      }),
    });
    const { identifyPlant } = await import('../../../src/services/plantIdentification.js');
    const result = await identifyPlant('AAAA');
    if (!result.configured) throw new Error('expected a configured result');
    expect(result.suggestions.map((s) => s.scientificName)).toEqual(['First', 'Second', 'Third']);
  });

  // --- Confidence floor (#344) ---------------------------------------------
  it('flags a below-floor top candidate as low confidence WITHOUT dropping any candidate', async () => {
    process.env = { ...ORIGINAL, PLANT_ID_API_KEY: 'k' };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: {
          classification: {
            suggestions: [
              { name: 'Peperomia obtusifolia', probability: 0.18 },
              { name: 'Pilea peperomioides', probability: 0.12 },
              { name: 'Hoya carnosa', probability: 0.04 },
            ],
          },
        },
      }),
    });
    const { identifyPlant, IDENTIFICATION_CONFIDENCE_FLOOR } =
      await import('../../../src/services/plantIdentification.js');
    const result = await identifyPlant('AAAA');
    if (!result.configured) throw new Error('expected a configured result');
    expect(result.lowConfidence).toBe(true);
    expect(result.confidenceFloor).toBe(IDENTIFICATION_CONFIDENCE_FLOOR);
    // Demoted, not filtered: all three are still offered. Filtering would make
    // an empty list mean both "not confident" and "identification failed".
    expect(result.suggestions).toHaveLength(3);
    expect(result.suggestions.map((s) => s.scientificName)).toContain('Hoya carnosa');
  });

  it('treats a top candidate exactly at the floor as confident (the floor is exclusive)', async () => {
    process.env = { ...ORIGINAL, PLANT_ID_API_KEY: 'k' };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: {
          classification: {
            suggestions: [{ name: 'Sansevieria trifasciata', probability: 0.3 }],
          },
        },
      }),
    });
    const { identifyPlant } = await import('../../../src/services/plantIdentification.js');
    const result = await identifyPlant('AAAA');
    if (!result.configured) throw new Error('expected a configured result');
    expect(result.lowConfidence).toBe(false);
  });

  it('judges confidence on the TOP candidate only — weak runners-up do not demote a strong match', async () => {
    process.env = { ...ORIGINAL, PLANT_ID_API_KEY: 'k' };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: {
          classification: {
            suggestions: [
              { name: 'Monstera deliciosa', probability: 0.97 },
              { name: 'Monstera adansonii', probability: 0.01 },
              { name: 'Rhaphidophora tetrasperma', probability: 0.01 },
            ],
          },
        },
      }),
    });
    const { identifyPlant } = await import('../../../src/services/plantIdentification.js');
    const result = await identifyPlant('AAAA');
    if (!result.configured) throw new Error('expected a configured result');
    expect(result.lowConfidence).toBe(false);
  });

  it('does not report low confidence when nothing came back — "no match" is not "no confident match"', async () => {
    process.env = { ...ORIGINAL, PLANT_ID_API_KEY: 'k' };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: { classification: { suggestions: [] } } }),
    });
    const { identifyPlant } = await import('../../../src/services/plantIdentification.js');
    const result = await identifyPlant('AAAA');
    if (!result.configured) throw new Error('expected a configured result');
    expect(result.suggestions).toEqual([]);
    expect(result.lowConfidence).toBe(false);
  });
});
