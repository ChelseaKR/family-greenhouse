import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  GetCommand: vi.fn(function (input) {
    return { input, kind: 'Get' };
  }),
  PutCommand: vi.fn(function (input) {
    return { input, kind: 'Put' };
  }),
  UpdateCommand: vi.fn(function (input) {
    return { input, kind: 'Update' };
  }),
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));
vi.mock('../../../src/services/weather.js', () => ({
  isConfigured: vi.fn(() => true),
  geocodeDetailed: vi.fn(),
  getWeatherDetailed: vi.fn(),
}));

const originalBudget = process.env.OPENWEATHER_DAILY_BUDGET;

describe('climate availability classification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENWEATHER_DAILY_BUDGET = '10';
  });

  afterEach(() => {
    if (originalBudget === undefined) delete process.env.OPENWEATHER_DAILY_BUDGET;
    else process.env.OPENWEATHER_DAILY_BUDGET = originalBudget;
  });

  it('returns null only for a valid geocoder response with no candidates', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const weather = await import('../../../src/services/weather.js');
    const { geocodeCached } = await import('../../../src/services/climate.js');
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({ Item: undefined } as never)
      .mockResolvedValueOnce({ Attributes: { used: 1 } } as never);
    vi.mocked(weather.geocodeDetailed).mockResolvedValueOnce({ status: 'not_found' });

    await expect(geocodeCached('Atlantis')).resolves.toBeNull();
  });

  it('throws a typed provider failure instead of mislabeling it as a bad place', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const weather = await import('../../../src/services/weather.js');
    const { ClimateUnavailableError, geocodeCached } =
      await import('../../../src/services/climate.js');
    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({ Item: undefined } as never)
      .mockResolvedValueOnce({ Attributes: { used: 1 } } as never);
    vi.mocked(weather.geocodeDetailed).mockResolvedValueOnce({
      status: 'unavailable',
      reason: 'provider',
    });

    await expect(geocodeCached('Austin')).rejects.toMatchObject({
      name: ClimateUnavailableError.name,
      reason: 'provider',
    });
  });

  it('throws typed failures when the daily budget is exhausted or cannot be checked', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    const { geocodeCached } = await import('../../../src/services/climate.js');
    process.env.OPENWEATHER_DAILY_BUDGET = '1';

    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({ Item: undefined } as never)
      .mockResolvedValueOnce({ Attributes: { used: 2 } } as never);
    await expect(geocodeCached('Austin')).rejects.toMatchObject({
      name: 'ClimateUnavailableError',
      reason: 'budget_exhausted',
    });

    vi.mocked(dynamodb.send)
      .mockResolvedValueOnce({ Item: undefined } as never)
      .mockRejectedValueOnce(new Error('DynamoDB unavailable'));
    await expect(geocodeCached('Austin')).rejects.toMatchObject({
      name: 'ClimateUnavailableError',
      reason: 'budget_check_failed',
    });
  });
});
