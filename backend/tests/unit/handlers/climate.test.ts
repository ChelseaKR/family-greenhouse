import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

// The climate handler reads from services/climate.ts (cached upstream weather
// + geocoding) and writes through services/householdService.ts. We mock both
// surfaces plus services/weather.ts for the `isConfigured()` gate the handler
// uses to tag the response.
vi.mock('../../../src/services/climate.js');
vi.mock('../../../src/services/householdService.js');
vi.mock('../../../src/services/weather.js', () => ({
  isConfigured: vi.fn(() => true),
}));

function buildEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    path: '/',
    pathParameters: null,
    queryStringParameters: null,
    requestContext: {
      authorizer: {
        claims: {
          sub: 'user-1',
          email: 'test@example.com',
          'custom:household_id': 'hh-1',
          'custom:household_role': 'admin',
        },
      },
      identity: { sourceIp: '127.0.0.1' },
    } as APIGatewayProxyEvent['requestContext'],
    resource: '/',
    stageVariables: null,
    ...overrides,
  };
}

const ctx = {} as Context;

describe('climate handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('getClimate', () => {
    it('returns weather + tips for a household with a saved location', async () => {
      const climate = await import('../../../src/services/climate.js');
      const householdService = await import('../../../src/services/householdService.js');
      const weather = await import('../../../src/services/weather.js');
      const { getClimate } = await import('../../../src/handlers/climate/handler.js');

      vi.mocked(weather.isConfigured).mockReturnValue(true);
      vi.mocked(householdService.getHousehold).mockResolvedValueOnce({
        id: 'hh-1',
        name: 'Home',
        location: { city: 'Austin', lat: 30.27, lon: -97.74 },
        createdAt: '',
        createdBy: 'user-1',
      });
      vi.mocked(climate.getWeatherCached).mockResolvedValueOnce({
        observedAt: '2026-06-01T00:00:00Z',
        tempC: 25,
        humidity: 50,
        condition: 'Clear',
        description: 'clear sky',
        forecast: [],
      });
      vi.mocked(climate.deriveClimateTips).mockReturnValueOnce([]);

      const res = (await getClimate(
        buildEvent({ pathParameters: { id: 'hh-1' } }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(200);
      expect(res.headers?.['Cache-Control']).toMatch(/private.*max-age=1800/);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({
        configured: true,
        weather: { tempC: 25, humidity: 50 },
        tips: [],
      });
      expect(climate.getWeatherCached).toHaveBeenCalledWith(30.27, -97.74);
    });

    it('returns null weather + empty tips when the household has no location', async () => {
      const climate = await import('../../../src/services/climate.js');
      const householdService = await import('../../../src/services/householdService.js');
      const { getClimate } = await import('../../../src/handlers/climate/handler.js');

      vi.mocked(householdService.getHousehold).mockResolvedValueOnce({
        id: 'hh-1',
        name: 'Home',
        location: null,
        createdAt: '',
        createdBy: 'user-1',
      });

      const res = (await getClimate(
        buildEvent({ pathParameters: { id: 'hh-1' } }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({ weather: null, tips: [] });
      expect(climate.getWeatherCached).not.toHaveBeenCalled();
    });

    it('returns null weather (but still 200) when budget is exhausted upstream', async () => {
      const climate = await import('../../../src/services/climate.js');
      const householdService = await import('../../../src/services/householdService.js');
      const { getClimate } = await import('../../../src/handlers/climate/handler.js');

      vi.mocked(householdService.getHousehold).mockResolvedValueOnce({
        id: 'hh-1',
        name: 'Home',
        location: { city: 'Austin', lat: 30.27, lon: -97.74 },
        createdAt: '',
        createdBy: 'user-1',
      });
      // getWeatherCached returns null when budget exhausted or the upstream
      // call fails — handler must treat that as "no weather" not as an error.
      vi.mocked(climate.getWeatherCached).mockResolvedValueOnce(null);

      const res = (await getClimate(
        buildEvent({ pathParameters: { id: 'hh-1' } }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.weather).toBeNull();
      expect(body.tips).toEqual([]);
      // deriveClimateTips is only called for a non-null snapshot.
      expect(climate.deriveClimateTips).not.toHaveBeenCalled();
    });

    it('returns 404 when the household does not exist', async () => {
      const householdService = await import('../../../src/services/householdService.js');
      const { getClimate } = await import('../../../src/handlers/climate/handler.js');

      vi.mocked(householdService.getHousehold).mockResolvedValueOnce(null);

      const res = (await getClimate(
        buildEvent({ pathParameters: { id: 'hh-missing' } }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(404);
      expect(res.body).toMatch(/household not found/i);
    });

    it('returns 400 when no household id can be inferred', async () => {
      const { getClimate } = await import('../../../src/handlers/climate/handler.js');

      const res = (await getClimate(
        buildEvent({
          requestContext: {
            authorizer: { claims: { sub: 'user-1', email: 'test@example.com' } },
          } as APIGatewayProxyEvent['requestContext'],
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(400);
      expect(res.body).toMatch(/household id required/i);
    });
  });

  describe('setLocation', () => {
    it('admin sets a city, server geocodes, saves resolved coords', async () => {
      const climate = await import('../../../src/services/climate.js');
      const householdService = await import('../../../src/services/householdService.js');
      const { setLocation } = await import('../../../src/handlers/climate/handler.js');

      vi.mocked(climate.geocodeCached).mockResolvedValueOnce({
        city: 'Austin',
        lat: 30.27,
        lon: -97.74,
        country: 'US',
      });
      vi.mocked(householdService.setHouseholdLocation).mockResolvedValueOnce({
        id: 'hh-1',
        name: 'Home',
        location: { city: 'Austin', lat: 30.27, lon: -97.74 },
        createdAt: '',
        createdBy: 'user-1',
      });

      const res = (await setLocation(
        buildEvent({
          httpMethod: 'PUT',
          pathParameters: { id: 'hh-1' },
          body: JSON.stringify({ city: 'Austin' }),
          headers: { 'content-type': 'application/json' },
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.location).toMatchObject({ city: 'Austin', lat: 30.27, lon: -97.74 });
      // Critical: client-supplied lat/lon is never trusted; we always run the
      // city string through our own geocoder.
      expect(climate.geocodeCached).toHaveBeenCalledWith('Austin');
      expect(householdService.setHouseholdLocation).toHaveBeenCalledWith('hh-1', {
        city: 'Austin',
        lat: 30.27,
        lon: -97.74,
      });
    });

    it('admin can clear the location with a null body', async () => {
      const climate = await import('../../../src/services/climate.js');
      const householdService = await import('../../../src/services/householdService.js');
      const { setLocation } = await import('../../../src/handlers/climate/handler.js');

      vi.mocked(householdService.setHouseholdLocation).mockResolvedValueOnce({
        id: 'hh-1',
        name: 'Home',
        location: null,
        createdAt: '',
        createdBy: 'user-1',
      });

      const res = (await setLocation(
        buildEvent({
          httpMethod: 'PUT',
          pathParameters: { id: 'hh-1' },
          body: JSON.stringify(null),
          headers: { 'content-type': 'application/json' },
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).location).toBeNull();
      expect(householdService.setHouseholdLocation).toHaveBeenCalledWith('hh-1', null);
      // No geocode lookup when clearing.
      expect(climate.geocodeCached).not.toHaveBeenCalled();
    });

    it('returns 400 when the city cannot be geocoded', async () => {
      const climate = await import('../../../src/services/climate.js');
      const householdService = await import('../../../src/services/householdService.js');
      const { setLocation } = await import('../../../src/handlers/climate/handler.js');

      vi.mocked(climate.geocodeCached).mockResolvedValueOnce(null);

      const res = (await setLocation(
        buildEvent({
          httpMethod: 'PUT',
          pathParameters: { id: 'hh-1' },
          body: JSON.stringify({ city: 'Notarealplace' }),
          headers: { 'content-type': 'application/json' },
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(400);
      expect(res.body).toMatch(/could not find that location/i);
      expect(householdService.setHouseholdLocation).not.toHaveBeenCalled();
    });

    it('rejects non-admin household members with 403', async () => {
      const { setLocation } = await import('../../../src/handlers/climate/handler.js');

      const res = (await setLocation(
        buildEvent({
          httpMethod: 'PUT',
          pathParameters: { id: 'hh-1' },
          body: JSON.stringify({ city: 'Austin' }),
          headers: { 'content-type': 'application/json' },
          requestContext: {
            authorizer: {
              claims: {
                sub: 'user-1',
                email: 'test@example.com',
                'custom:household_id': 'hh-1',
                'custom:household_role': 'member',
              },
            },
          } as APIGatewayProxyEvent['requestContext'],
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(403);
      expect(res.body).toMatch(/admin/i);
    });

    it('returns 403 when caller has no household claim (requireHousehold)', async () => {
      const { setLocation } = await import('../../../src/handlers/climate/handler.js');

      const res = (await setLocation(
        buildEvent({
          httpMethod: 'PUT',
          pathParameters: { id: 'hh-1' },
          body: JSON.stringify({ city: 'Austin' }),
          headers: { 'content-type': 'application/json' },
          requestContext: {
            authorizer: { claims: { sub: 'user-1', email: 'test@example.com' } },
          } as APIGatewayProxyEvent['requestContext'],
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(403);
    });

    it('rejects an empty city string (Zod min(1))', async () => {
      const { setLocation } = await import('../../../src/handlers/climate/handler.js');

      const res = (await setLocation(
        buildEvent({
          httpMethod: 'PUT',
          pathParameters: { id: 'hh-1' },
          body: JSON.stringify({ city: '' }),
          headers: { 'content-type': 'application/json' },
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(400);
    });
  });
});
