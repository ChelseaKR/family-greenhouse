import { beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { climateService } from '@/services/climateService';
import { track } from '@/services/analytics';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

vi.mock('@/services/analytics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/analytics')>();
  return { ...actual, track: vi.fn() };
});

const API = 'http://localhost:4000';

describe('climateService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ accessToken: 'access-1' });
  });

  it('reports an unconfigured provider without inventing weather', async () => {
    server.use(
      http.get(`${API}/households/hh-1/climate`, () =>
        HttpResponse.json({ configured: false, weather: null, tips: [] })
      )
    );

    const climate = await climateService.getClimate('hh-1');

    expect(climate).toMatchObject({ configured: false, weather: null });
    expect(climate.tips).toEqual([]);
  });

  it('returns the snapshot and derived tips when configured', async () => {
    server.use(
      http.get(`${API}/households/hh-1/climate`, () =>
        HttpResponse.json({
          configured: true,
          weather: {
            observedAt: '2026-08-03T12:00:00Z',
            tempC: 31,
            humidity: 22,
            condition: 'Clear',
            description: 'clear sky',
            forecast: [{ date: '2026-08-04', minC: 20, maxC: 33, humidity: 25 }],
          },
          tips: [{ level: 'warning', appliesTo: ['tropical'], message: 'Air is very dry.' }],
          location: { city: 'Portland', lat: 45.5, lon: -122.7 },
        })
      )
    );

    const climate = await climateService.getClimate('hh-1');

    expect(climate.weather?.humidity).toBe(22);
    expect(climate.tips[0].level).toBe('warning');
  });

  it('tracks setting a location but not clearing one', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.put(`${API}/households/hh-1/location`, async ({ request }) => {
        const text = await request.text();
        bodies.push(text === '' ? null : JSON.parse(text));
        return HttpResponse.json({ ok: true });
      })
    );

    await climateService.setLocation('hh-1', 'Portland');
    expect(track).toHaveBeenCalledWith('climate_location_set');

    vi.mocked(track).mockClear();
    await climateService.setLocation('hh-1', null);
    expect(track).not.toHaveBeenCalled();

    expect(bodies[0]).toEqual({ city: 'Portland' });
    expect(bodies[1]).toBeNull();
  });
});
