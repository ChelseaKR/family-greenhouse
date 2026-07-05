import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

vi.mock('../../../src/services/enrichment.js');
vi.mock('../../../src/services/perenual.js', () => ({
  isConfigured: vi.fn(async () => true),
}));
// authMiddleware (on the authenticated routes) validates the claim household
// against the membership table.
vi.mock('../../../src/services/householdService.js', () => ({
  getMemberByUserId: vi.fn(async () => ({
    householdId: 'hh-1',
    userId: 'user-1',
    name: 'Tester',
    email: 'a@b.com',
    role: 'member',
    joinedAt: '',
  })),
}));

function buildEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    path: '/species/7/thumbnail',
    pathParameters: { id: '7' },
    queryStringParameters: null,
    requestContext: {
      authorizer: {
        claims: {
          sub: 'user-1',
          email: 'a@b.com',
          'custom:household_id': 'hh-1',
          'custom:household_role': 'member',
        },
      },
      identity: { sourceIp: '127.0.0.1' },
    } as APIGatewayProxyEvent['requestContext'],
    resource: '/',
    stageVariables: null,
    ...overrides,
  };
}

/** Anonymous variant — the thumbnail route is public (auth=none) at the gateway. */
function buildAnonymousEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  const event = buildEvent(overrides);
  delete (event.requestContext as { authorizer?: unknown }).authorizer;
  return event;
}

const ctx = {} as Context;

const baseDetail = {
  id: 7,
  commonName: 'Monstera',
  scientificName: 'Monstera deliciosa',
  thumbnailUrl: 'https://perenual.com/storage/thumb.jpg',
  family: null,
  cycle: null,
  watering: null,
  sunlight: [],
  hardinessZone: null,
  indoor: true,
  edible: false,
  poisonousToPets: false,
  defaultImageUrl: 'https://images.perenual.com/full.jpg',
};

describe('species handler', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { __resetMembershipCacheForTests } = await import('../../../src/middleware/auth.js');
    __resetMembershipCacheForTests();
    const { __resetRateLimitForTests } = await import('../../../src/middleware/rateLimit.js');
    __resetRateLimitForTests();
  });

  describe('thumbnail (public route)', () => {
    it('302-redirects to an allowlisted Perenual host for anonymous callers', async () => {
      const enrichment = await import('../../../src/services/enrichment.js');
      const { thumbnail } = await import('../../../src/handlers/species/handler.js');
      vi.mocked(enrichment.getSpeciesCached).mockResolvedValueOnce(baseDetail);

      // No authorizer at all — <img> tags can't send JWTs.
      const res = (await thumbnail(buildAnonymousEvent(), ctx, () => {})) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(302);
      expect(res.headers?.Location).toBe('https://perenual.com/storage/thumb.jpg');
      expect(res.headers?.['Cache-Control']).toMatch(/max-age=86400/);
    });

    it('returns 404 instead of redirecting to a non-allowlisted host', async () => {
      const enrichment = await import('../../../src/services/enrichment.js');
      const { thumbnail } = await import('../../../src/handlers/species/handler.js');
      vi.mocked(enrichment.getSpeciesCached).mockResolvedValueOnce({
        ...baseDetail,
        thumbnailUrl: 'https://evil.example.com/phish.jpg',
        defaultImageUrl: null,
      });

      const res = (await thumbnail(buildAnonymousEvent(), ctx, () => {})) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(404);
      expect(res.headers?.Location).toBeUndefined();
    });

    it('rejects non-https schemes even on an allowlisted host', async () => {
      const enrichment = await import('../../../src/services/enrichment.js');
      const { thumbnail } = await import('../../../src/handlers/species/handler.js');
      vi.mocked(enrichment.getSpeciesCached).mockResolvedValueOnce({
        ...baseDetail,
        thumbnailUrl: 'http://perenual.com/storage/thumb.jpg',
        defaultImageUrl: null,
      });

      const res = (await thumbnail(buildAnonymousEvent(), ctx, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(404);
    });

    it('rejects unparseable / scheme-smuggling URLs', async () => {
      const enrichment = await import('../../../src/services/enrichment.js');
      const { thumbnail } = await import('../../../src/handlers/species/handler.js');
      for (const url of ['javascript:alert(1)', 'not a url', '//perenual.com/x.jpg']) {
        vi.mocked(enrichment.getSpeciesCached).mockResolvedValueOnce({
          ...baseDetail,
          thumbnailUrl: url,
          defaultImageUrl: null,
        });
        const res = (await thumbnail(
          buildAnonymousEvent(),
          ctx,
          () => {}
        )) as APIGatewayProxyResult;
        expect(res.statusCode).toBe(404);
      }
    });

    it('404s on a non-numeric id without echoing it or hitting the cache', async () => {
      const enrichment = await import('../../../src/services/enrichment.js');
      const { thumbnail } = await import('../../../src/handlers/species/handler.js');

      const res = (await thumbnail(
        buildAnonymousEvent({ pathParameters: { id: '<script>alert(1)</script>' } }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(404);
      expect(res.body).not.toMatch(/script/);
      expect(enrichment.getSpeciesCached).not.toHaveBeenCalled();
    });

    it('falls back to defaultImageUrl when thumbnailUrl is missing', async () => {
      const enrichment = await import('../../../src/services/enrichment.js');
      const { thumbnail } = await import('../../../src/handlers/species/handler.js');
      vi.mocked(enrichment.getSpeciesCached).mockResolvedValueOnce({
        ...baseDetail,
        thumbnailUrl: null,
      });

      const res = (await thumbnail(buildAnonymousEvent(), ctx, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(302);
      expect(res.headers?.Location).toBe('https://images.perenual.com/full.jpg');
    });

    it('applies an IP rate limit (429 after 60 requests/min)', async () => {
      const enrichment = await import('../../../src/services/enrichment.js');
      const { thumbnail } = await import('../../../src/handlers/species/handler.js');
      vi.mocked(enrichment.getSpeciesCached).mockResolvedValue(baseDetail);

      for (let i = 0; i < 60; i++) {
        const res = (await thumbnail(
          buildAnonymousEvent(),
          ctx,
          () => {}
        )) as APIGatewayProxyResult;
        expect(res.statusCode).toBe(302);
      }
      const res = (await thumbnail(buildAnonymousEvent(), ctx, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(429);
    });
  });

  describe('detail', () => {
    it('includes an allowlist-sanitized thumbnailUrl directly in the response', async () => {
      const enrichment = await import('../../../src/services/enrichment.js');
      const { detail } = await import('../../../src/handlers/species/handler.js');
      vi.mocked(enrichment.getSpeciesCached).mockResolvedValueOnce(baseDetail);

      const res = (await detail(
        buildEvent({ path: '/species/7', pathParameters: { id: '7' } }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.result.thumbnailUrl).toBe('https://perenual.com/storage/thumb.jpg');
    });

    it('nulls a poisoned (non-allowlisted) thumbnailUrl rather than passing it through', async () => {
      const enrichment = await import('../../../src/services/enrichment.js');
      const { detail } = await import('../../../src/handlers/species/handler.js');
      vi.mocked(enrichment.getSpeciesCached).mockResolvedValueOnce({
        ...baseDetail,
        thumbnailUrl: 'https://evil.example.com/x.jpg',
        defaultImageUrl: 'https://evil.example.com/y.jpg',
      });

      const res = (await detail(
        buildEvent({ path: '/species/7', pathParameters: { id: '7' } }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(JSON.parse(res.body).result.thumbnailUrl).toBeNull();
    });

    it('requires authentication (unlike the thumbnail route)', async () => {
      const { detail } = await import('../../../src/handlers/species/handler.js');
      const res = (await detail(
        buildAnonymousEvent({ path: '/species/7', pathParameters: { id: '7' } }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(401);
    });
  });

  describe('search', () => {
    it('reports source "disabled" only when Perenual is unconfigured', async () => {
      const perenual = await import('../../../src/services/perenual.js');
      vi.mocked(perenual.isConfigured).mockResolvedValueOnce(false);
      const enrichment = await import('../../../src/services/enrichment.js');
      // Matches enrichment.searchSpeciesCached's own behavior when
      // unconfigured (it short-circuits to null before ever touching the
      // budget/cache) — an auto-mocked `undefined` would take the wrong
      // branch below (`undefined !== null` is true).
      vi.mocked(enrichment.searchSpeciesCached).mockResolvedValueOnce(null);
      const { search } = await import('../../../src/handlers/species/handler.js');

      const res = (await search(
        buildEvent({ path: '/species/search', queryStringParameters: { q: 'monstera' } }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;
      expect(JSON.parse(res.body).source).toBe('disabled');
    });

    it('reports source "unavailable" (not "disabled") when configured but the request got no data', async () => {
      const enrichment = await import('../../../src/services/enrichment.js');
      vi.mocked(enrichment.searchSpeciesCached).mockResolvedValueOnce(null);
      const { search } = await import('../../../src/handlers/species/handler.js');

      const res = (await search(
        buildEvent({ path: '/species/search', queryStringParameters: { q: 'monstera' } }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;
      // A real outage or exhausted daily budget must not look identical to
      // the integration being intentionally turned off.
      expect(JSON.parse(res.body).source).toBe('unavailable');
    });

    it('reports source "perenual" and the results when the search succeeds', async () => {
      const enrichment = await import('../../../src/services/enrichment.js');
      vi.mocked(enrichment.searchSpeciesCached).mockResolvedValueOnce([
        { id: 1, commonName: 'Monstera', scientificName: 'Monstera deliciosa', thumbnailUrl: null },
      ]);
      const { search } = await import('../../../src/handlers/species/handler.js');

      const res = (await search(
        buildEvent({ path: '/species/search', queryStringParameters: { q: 'monstera' } }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;
      const body = JSON.parse(res.body);
      expect(body.source).toBe('perenual');
      expect(body.results).toHaveLength(1);
    });

    it('caps an oversized query instead of forwarding it verbatim', async () => {
      const enrichment = await import('../../../src/services/enrichment.js');
      vi.mocked(enrichment.searchSpeciesCached).mockResolvedValueOnce([]);
      const { search } = await import('../../../src/handlers/species/handler.js');

      const huge = 'a'.repeat(5000);
      await search(
        buildEvent({ path: '/species/search', queryStringParameters: { q: huge } }),
        ctx,
        () => {}
      );
      expect(vi.mocked(enrichment.searchSpeciesCached)).toHaveBeenCalledWith('a'.repeat(80));
    });
  });

  describe('invalid species id (must be rejected, not silently truncated or treated as "no data")', () => {
    it.each(['7abc', '7e2', '-1', '0', 'NaN', ''])(
      'detail rejects id=%s with 400, without calling the enrichment cache',
      async (badId) => {
        const enrichment = await import('../../../src/services/enrichment.js');
        const { detail } = await import('../../../src/handlers/species/handler.js');

        const res = (await detail(
          buildEvent({ path: `/species/${badId}`, pathParameters: { id: badId } }),
          ctx,
          () => {}
        )) as APIGatewayProxyResult;
        expect(res.statusCode).toBe(400);
        expect(enrichment.getSpeciesCached).not.toHaveBeenCalled();
      }
    );

    it('guide rejects a garbage-suffixed id ("7abc") with 400 rather than silently serving species 7', async () => {
      const enrichment = await import('../../../src/services/enrichment.js');
      const { guide } = await import('../../../src/handlers/species/handler.js');

      const res = (await guide(
        buildEvent({ path: '/species/7abc/guide', pathParameters: { id: '7abc' } }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(400);
      expect(enrichment.getSpeciesCached).not.toHaveBeenCalled();
    });

    it('careSuggestions rejects a garbage-suffixed id ("7abc") with 400', async () => {
      const enrichment = await import('../../../src/services/enrichment.js');
      const { careSuggestions } = await import('../../../src/handlers/species/handler.js');

      const res = (await careSuggestions(
        buildEvent({ path: '/species/7abc/care-suggestions', pathParameters: { id: '7abc' } }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(400);
      expect(enrichment.getSpeciesCached).not.toHaveBeenCalled();
    });

    it('thumbnail still 404s (not 400) on a garbage-suffixed id — it is a public, unauthenticated redirect route', async () => {
      const enrichment = await import('../../../src/services/enrichment.js');
      const { thumbnail } = await import('../../../src/handlers/species/handler.js');

      const res = (await thumbnail(
        buildAnonymousEvent({ pathParameters: { id: '7abc' } }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(404);
      expect(enrichment.getSpeciesCached).not.toHaveBeenCalled();
    });

    it('detail still returns 200 {result: null} for a valid but unknown/no-data id (distinct from a malformed one)', async () => {
      const enrichment = await import('../../../src/services/enrichment.js');
      vi.mocked(enrichment.getSpeciesCached).mockResolvedValueOnce(null);
      const { detail } = await import('../../../src/handlers/species/handler.js');

      const res = (await detail(
        buildEvent({ path: '/species/999999', pathParameters: { id: '999999' } }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).result).toBeNull();
    });
  });

  describe('toxicity (public pet-safety lookup)', () => {
    it('answers an anonymous query with cat/dog verdicts and a public cache header', async () => {
      const { toxicity } = await import('../../../src/handlers/species/handler.js');
      const res = (await toxicity(
        buildAnonymousEvent({
          path: '/species/toxicity',
          pathParameters: null,
          queryStringParameters: { q: 'snake plant' },
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(200);
      expect(res.headers?.['Cache-Control']).toMatch(/public/);
      const body = JSON.parse(res.body);
      expect(body.results[0]).toMatchObject({
        slug: 'snake-plant',
        cats: 'toxic',
        dogs: 'toxic',
      });
      expect(typeof body.results[0].note).toBe('string');
    });

    it('matches by scientific name and alias, not just common name', async () => {
      const { toxicity } = await import('../../../src/handlers/species/handler.js');
      const call = async (q: string) => {
        const res = (await toxicity(
          buildAnonymousEvent({ path: '/species/toxicity', queryStringParameters: { q } }),
          ctx,
          () => {}
        )) as APIGatewayProxyResult;
        return JSON.parse(res.body).results;
      };
      expect((await call('chlorophytum comosum'))[0].slug).toBe('spider-plant');
      expect((await call('devils ivy'))[0].slug).toBe('pothos');
    });

    it('surfaces the safe verdict for a non-toxic plant', async () => {
      const { toxicity } = await import('../../../src/handlers/species/handler.js');
      const res = (await toxicity(
        buildAnonymousEvent({
          path: '/species/toxicity',
          queryStringParameters: { q: 'spider plant' },
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;
      const body = JSON.parse(res.body);
      expect(body.results[0]).toMatchObject({ cats: 'non-toxic', dogs: 'non-toxic' });
    });

    it('returns an empty result set (not an error) for a too-short or unknown query', async () => {
      const { toxicity } = await import('../../../src/handlers/species/handler.js');
      const call = async (q: string) => {
        const res = (await toxicity(
          buildAnonymousEvent({ path: '/species/toxicity', queryStringParameters: { q } }),
          ctx,
          () => {}
        )) as APIGatewayProxyResult;
        expect(res.statusCode).toBe(200);
        return JSON.parse(res.body).results;
      };
      expect(await call('a')).toEqual([]);
      expect(await call('zzzznotaplant')).toEqual([]);
    });

    it('applies an IP rate limit (429 after 60 requests/min)', async () => {
      const { toxicity } = await import('../../../src/handlers/species/handler.js');
      const event = () =>
        buildAnonymousEvent({ path: '/species/toxicity', queryStringParameters: { q: 'pothos' } });
      for (let i = 0; i < 60; i++) {
        const res = (await toxicity(event(), ctx, () => {})) as APIGatewayProxyResult;
        expect(res.statusCode).toBe(200);
      }
      const res = (await toxicity(event(), ctx, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(429);
    });
  });

  describe('rate limits on metered routes', () => {
    it('guide is capped at 10/min per user', async () => {
      const enrichment = await import('../../../src/services/enrichment.js');
      const { guide } = await import('../../../src/handlers/species/handler.js');
      vi.mocked(enrichment.getSpeciesCached).mockResolvedValue(baseDetail);
      vi.mocked(enrichment.getCareGuideCached).mockResolvedValue(null);

      const event = () => buildEvent({ path: '/species/7/guide', pathParameters: { id: '7' } });
      for (let i = 0; i < 10; i++) {
        const res = (await guide(event(), ctx, () => {})) as APIGatewayProxyResult;
        expect(res.statusCode).toBe(200);
      }
      const res = (await guide(event(), ctx, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(429);
    });

    it('search is capped at 30/min per user', async () => {
      const enrichment = await import('../../../src/services/enrichment.js');
      const { search } = await import('../../../src/handlers/species/handler.js');
      vi.mocked(enrichment.searchSpeciesCached).mockResolvedValue([]);

      const event = () =>
        buildEvent({ path: '/species/search', queryStringParameters: { q: 'monstera' } });
      for (let i = 0; i < 30; i++) {
        const res = (await search(event(), ctx, () => {})) as APIGatewayProxyResult;
        expect(res.statusCode).toBe(200);
      }
      const res = (await search(event(), ctx, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(429);
    });

    it('care-suggestions is capped at 10/min per user', async () => {
      const enrichment = await import('../../../src/services/enrichment.js');
      const { careSuggestions } = await import('../../../src/handlers/species/handler.js');
      vi.mocked(enrichment.getSpeciesCached).mockResolvedValue(baseDetail);

      const event = () =>
        buildEvent({ path: '/species/7/care-suggestions', pathParameters: { id: '7' } });
      for (let i = 0; i < 10; i++) {
        const res = (await careSuggestions(event(), ctx, () => {})) as APIGatewayProxyResult;
        expect(res.statusCode).toBe(200);
      }
      const res = (await careSuggestions(event(), ctx, () => {})) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(429);
    });
  });
});
