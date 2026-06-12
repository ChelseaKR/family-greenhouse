import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isConfigured, geocode, getWeather } from '../../../src/services/weather.js';

const ORIGINAL = process.env;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  process.env = { ...ORIGINAL, OPENWEATHER_API_KEY: 'owm-key' };
});

afterEach(() => {
  process.env = ORIGINAL;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('weather client (OpenWeatherMap)', () => {
  it('short-circuits to null everywhere when OPENWEATHER_API_KEY is unset', async () => {
    delete process.env.OPENWEATHER_API_KEY;
    expect(isConfigured()).toBe(false);
    expect(await geocode('Durham, NC')).toBeNull();
    expect(await getWeather(35.99, -78.9)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports configured when the key is present', () => {
    expect(isConfigured()).toBe(true);
  });

  describe('geocode', () => {
    it('maps the best candidate to {city, lat, lon, country}', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => [{ name: 'Durham', lat: 35.994, lon: -78.8986, country: 'US' }],
      });

      const out = await geocode('  Durham, NC  ');
      expect(out).toEqual({ city: 'Durham', lat: 35.994, lon: -78.8986, country: 'US' });

      const url = new URL(fetchMock.mock.calls[0][0] as string);
      expect(url.pathname).toBe('/geo/1.0/direct');
      // Query is trimmed before being sent upstream.
      expect(url.searchParams.get('q')).toBe('Durham, NC');
      expect(url.searchParams.get('limit')).toBe('1');
      expect(url.searchParams.get('appid')).toBe('owm-key');
    });

    it('defaults country to null when upstream omits it', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => [{ name: 'Atlantis', lat: 0, lon: 0 }],
      });
      expect((await geocode('Atlantis'))?.country).toBeNull();
    });

    it('returns null when there are no candidates', async () => {
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [] });
      expect(await geocode('xyzzy nowhere')).toBeNull();
    });
  });

  describe('getWeather', () => {
    const rawOneCall = {
      current: {
        dt: 1_750_000_000,
        temp: 24.3,
        humidity: 61,
        weather: [{ main: 'Clouds', description: 'scattered clouds' }],
      },
      daily: [
        { dt: 1_750_000_000, temp: { min: 18, max: 27 }, humidity: 60 },
        { dt: 1_750_086_400, temp: { min: 17, max: 26 }, humidity: 65 },
        { dt: 1_750_172_800, temp: { min: 19, max: 28 }, humidity: 55 },
        { dt: 1_750_259_200, temp: { min: 20, max: 30 }, humidity: 50 },
      ],
    };

    it('maps current conditions and slices the forecast to 3 days', async () => {
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => rawOneCall });

      const snap = await getWeather(35.99, -78.9);
      expect(snap).toEqual({
        observedAt: new Date(1_750_000_000 * 1000).toISOString(),
        tempC: 24.3,
        humidity: 61,
        condition: 'Clouds',
        description: 'scattered clouds',
        forecast: [
          { date: '2025-06-15', minC: 18, maxC: 27, humidity: 60 },
          { date: '2025-06-16', minC: 17, maxC: 26, humidity: 65 },
          { date: '2025-06-17', minC: 19, maxC: 28, humidity: 55 },
        ],
      });

      const url = new URL(fetchMock.mock.calls[0][0] as string);
      expect(url.pathname).toBe('/data/3.0/onecall');
      expect(url.searchParams.get('units')).toBe('metric');
      expect(url.searchParams.get('exclude')).toBe('minutely,hourly,alerts');
    });

    it('tolerates a payload without weather[] or daily[] (Unknown condition, empty forecast)', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ current: { dt: 1_750_000_000, temp: 20, humidity: 50 } }),
      });
      const snap = await getWeather(1, 2);
      expect(snap?.condition).toBe('Unknown');
      expect(snap?.description).toBe('');
      expect(snap?.forecast).toEqual([]);
    });

    it('returns null when `current` is missing entirely', async () => {
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ daily: [] }) });
      expect(await getWeather(1, 2)).toBeNull();
    });
  });

  describe('failure modes (never throws)', () => {
    it('returns null on non-2xx', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });
      expect(await geocode('Durham')).toBeNull();
    });

    it('returns null when fetch rejects (DNS, reset, ...)', async () => {
      fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
      expect(await getWeather(1, 2)).toBeNull();
    });

    it('returns null on malformed JSON', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected token');
        },
      });
      expect(await geocode('Durham')).toBeNull();
    });

    it('aborts a hung request after the 5s timeout and returns null', async () => {
      vi.useFakeTimers();
      // A fetch that never settles on its own — only the abort signal can
      // end it, exactly like an upstream that goes silent mid-request.
      fetchMock.mockImplementationOnce(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () =>
              reject(new DOMException('The operation was aborted.', 'AbortError'))
            );
          })
      );

      const pending = getWeather(1, 2);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(pending).resolves.toBeNull();
    });
  });
});
