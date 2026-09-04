import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WeatherSnapshot } from '../../../src/services/weather.js';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  GetCommand: vi.fn(function (input) {
    return { kind: 'Get', input };
  }),
  PutCommand: vi.fn(function (input) {
    return { kind: 'Put', input };
  }),
  UpdateCommand: vi.fn(function (input) {
    return { kind: 'Update', input };
  }),
}));

vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));

vi.mock('../../../src/services/weather.js', () => ({
  isConfigured: vi.fn(() => true),
  getWeatherDetailed: vi.fn(),
  geocodeDetailed: vi.fn(),
}));

const base: WeatherSnapshot = {
  observedAt: '2026-10-14T18:00:00.000Z',
  tempC: 12,
  humidity: 50,
  condition: 'Clear',
  description: 'clear sky',
  forecast: [{ date: '2026-10-14', minC: 8, maxC: 15, humidity: 50 }],
};

describe('seasonalSignal', () => {
  it('says winter when tonight drops under the frost line', async () => {
    const { seasonalSignal, FROST_LOW_C } = await import('../../../src/services/climate.js');
    const snap = { ...base, forecast: [{ ...base.forecast[0], minC: FROST_LOW_C - 1 }] };
    expect(seasonalSignal(snap)).toBe('winter');
  });

  it('falls back to the current temperature when there is no forecast', async () => {
    const { seasonalSignal } = await import('../../../src/services/climate.js');
    expect(seasonalSignal({ ...base, tempC: 2, forecast: [] })).toBe('winter');
    expect(seasonalSignal({ ...base, tempC: 12, forecast: [] })).toBeNull();
  });

  it('says summer when today crosses the heat line', async () => {
    const { seasonalSignal, HEAT_HIGH_C } = await import('../../../src/services/climate.js');
    expect(seasonalSignal({ ...base, tempC: HEAT_HIGH_C + 1 })).toBe('summer');
  });

  it('is null at the lines themselves and on a mild day', async () => {
    const { seasonalSignal, FROST_LOW_C, HEAT_HIGH_C } =
      await import('../../../src/services/climate.js');
    expect(seasonalSignal(base)).toBeNull();
    expect(
      seasonalSignal({ ...base, forecast: [{ ...base.forecast[0], minC: FROST_LOW_C }] })
    ).toBeNull();
    expect(seasonalSignal({ ...base, tempC: HEAT_HIGH_C })).toBeNull();
  });

  it('lets frost win over heat on the same day', async () => {
    const { seasonalSignal } = await import('../../../src/services/climate.js');
    const snap = { ...base, tempC: 34, forecast: [{ ...base.forecast[0], minC: 3 }] };
    expect(seasonalSignal(snap)).toBe('winter');
  });

  // Move Day may only fire on a night the climate card itself would have
  // warned about. Both read the same constants; this pins that they agree.
  it('agrees with deriveClimateTips on both lines', async () => {
    const { seasonalSignal, deriveClimateTips } = await import('../../../src/services/climate.js');
    const frosty = { ...base, forecast: [{ ...base.forecast[0], minC: 4 }] };
    expect(seasonalSignal(frosty)).toBe('winter');
    expect(
      deriveClimateTips(frosty).some((t) => /bring tender plants indoors/i.test(t.message))
    ).toBe(true);

    const hot = { ...base, tempC: 33 };
    expect(seasonalSignal(hot)).toBe('summer');
    expect(deriveClimateTips(hot).some((t) => /hot today/i.test(t.message))).toBe(true);

    expect(seasonalSignal(base)).toBeNull();
    expect(deriveClimateTips(base)).toEqual([]);
  });
});

describe('peekWeatherCached', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the live cached snapshot with a single read and no budget write', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { peekWeatherCached } = await import('../../../src/services/climate.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Item: { payload: base, ttl: Math.floor(Date.now() / 1000) + 600 },
    } as never);

    await expect(peekWeatherCached(45.5231, -122.6765)).resolves.toEqual(base);
    expect(dynamodb.send).toHaveBeenCalledTimes(1);
    const call = vi.mocked(dynamodb.send).mock.calls[0][0] as unknown as {
      kind: string;
      input: { Key: { PK: string; SK: string } };
    };
    expect(call.kind).toBe('Get');
    expect(call.input.Key).toEqual({ PK: 'WEATHER#CACHE', SK: 'WEATHER#45.523,-122.677' });
  });

  it('is null when nothing is cached or the row has expired', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { peekWeatherCached } = await import('../../../src/services/climate.js');
    vi.mocked(dynamodb.send).mockResolvedValueOnce({} as never);
    await expect(peekWeatherCached(1, 2)).resolves.toBeNull();

    vi.mocked(dynamodb.send).mockResolvedValueOnce({
      Item: { payload: base, ttl: Math.floor(Date.now() / 1000) - 1 },
    } as never);
    await expect(peekWeatherCached(1, 2)).resolves.toBeNull();
  });

  it('never fetches: a failed cache read is null, not a provider call', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const weather = await import('../../../src/services/weather.js');
    const { peekWeatherCached } = await import('../../../src/services/climate.js');
    vi.mocked(dynamodb.send).mockRejectedValueOnce(new Error('ddb down'));

    await expect(peekWeatherCached(1, 2)).resolves.toBeNull();
    expect(weather.getWeatherDetailed).not.toHaveBeenCalled();
    expect(dynamodb.send).toHaveBeenCalledTimes(1);
  });
});
