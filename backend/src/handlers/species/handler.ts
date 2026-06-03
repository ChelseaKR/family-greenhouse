/**
 * Species autocomplete + lookup endpoints. Backed by the Perenual enrichment
 * cache so we never expose raw Perenual responses or our API key to the
 * client.
 *
 * The endpoints return null/empty arrays gracefully when Perenual is not
 * configured or the daily budget is exhausted — the frontend falls back to
 * its static catalog in that case, so users never see an outright failure.
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { createHandler } from '../../middleware/handler.js';
import { createRouter } from '../../middleware/router.js';
import { authMiddleware } from '../../middleware/auth.js';
import { successResponse, cacheableResponse } from '../../utils/response.js';
import * as enrichment from '../../services/enrichment.js';
import { isConfigured } from '../../services/perenual.js';
import { deriveCareSuggestion } from '../../services/careRecommendations.js';

// GET /species/search?q=...
// Public catalog: same query → same answer for every user. 5-minute
// CloudFront cache mirrors the server-side TTL on `SEARCH#…` rows.
export const search = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const q = (event.queryStringParameters?.q ?? '').trim();
    if (!q || q.length < 2) {
      return successResponse({
        source: (await isConfigured()) ? 'perenual' : 'disabled',
        results: [],
      });
    }
    const hits = await enrichment.searchSpeciesCached(q);
    return cacheableResponse(
      {
        source: hits === null ? 'disabled' : 'perenual',
        results: hits ?? [],
      },
      { maxAgeSeconds: 300, visibility: 'public' }
    );
  }
).use(authMiddleware());

// GET /species/{id}
// Botanical detail rarely changes; cache for an hour at the edge.
export const detail = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const idStr = event.pathParameters?.id ?? '';
    const id = Number.parseInt(idStr, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return successResponse({ result: null });
    }
    const detail = await enrichment.getSpeciesCached(id);
    return cacheableResponse({ result: detail }, { maxAgeSeconds: 3600, visibility: 'public' });
  }
).use(authMiddleware());

// GET /species/{id}/thumbnail — returns a redirect to the Perenual thumbnail
// URL (or a 404 if we have no enrichment for this species). Living behind
// our domain means the frontend doesn't need to know Perenual's CDN host
// and we can swap providers without a frontend change.
export const thumbnail = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const idStr = event.pathParameters?.id ?? '';
    const id = Number.parseInt(idStr, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return { statusCode: 404, body: '' };
    }
    const detail = await enrichment.getSpeciesCached(id);
    const url = detail?.thumbnailUrl ?? detail?.defaultImageUrl ?? null;
    if (!url) return { statusCode: 404, body: '' };
    // Allowlist Perenual's media hosts to close an open-redirect path: the
    // cached `url` is upstream-supplied JSON, so a poisoned upstream entry
    // could otherwise redirect users to an arbitrary host. We don't leak
    // auth on a redirect (the browser drops Authorization) but we'd still
    // be lending our domain to a phishing target.
    if (!isAllowedThumbnailHost(url)) {
      return { statusCode: 404, body: '' };
    }
    return {
      statusCode: 302,
      headers: {
        Location: url,
        // Browser cache for a day; Perenual images don't change.
        'Cache-Control': 'public, max-age=86400',
      },
      body: '',
    };
  }
).use(authMiddleware());

const ALLOWED_THUMBNAIL_HOSTS = new Set([
  'perenual.com',
  'www.perenual.com',
  'images.perenual.com',
  'cdn.perenual.com',
  'perenualuploads.s3.amazonaws.com',
]);

function isAllowedThumbnailHost(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:') return false;
    return ALLOWED_THUMBNAIL_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

// GET /species/{id}/guide — long-form care guide for the plant detail page.
// Bundles the watering/sunlight/pruning prose with a few derived fields
// (toxicity, hardiness, whether it's typically grown indoors) so the
// frontend can render the whole tab from a single response.
//
// Accepts a `?locale=xx` parameter for forward-compatibility. Perenual is
// English-only, so non-English locales currently fall through to English
// content. When we wire up AWS Translate, this is the seam: the handler
// will translate `careGuide.sections` per-locale and cache the translation
// alongside the source row. The response shape doesn't change — clients
// just see localized strings.
export const guide = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const idStr = event.pathParameters?.id ?? '';
    const id = Number.parseInt(idStr, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return successResponse({ result: null });
    }
    const locale = (event.queryStringParameters?.locale ?? 'en').toLowerCase();
    const [detail, careGuide] = await Promise.all([
      enrichment.getSpeciesCached(id),
      enrichment.getCareGuideCached(id),
    ]);
    if (!detail) return successResponse({ result: null });
    return successResponse({
      result: {
        commonName: detail.commonName,
        scientificName: detail.scientificName,
        family: detail.family,
        cycle: detail.cycle,
        hardinessZone: detail.hardinessZone,
        indoor: detail.indoor,
        poisonousToPets: detail.poisonousToPets,
        sunlight: detail.sunlight,
        sections: careGuide?.sections ?? [],
        locale,
        translated: false, // becomes true once AWS Translate is wired up
      },
    });
  }
).use(authMiddleware());

// GET /species/{id}/care-suggestions — small derived view used by the
// AddPlant flow to seed a default watering schedule. Separate endpoint so
// the frontend doesn't have to know about Perenual's enum vocabulary.
export const careSuggestions = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const idStr = event.pathParameters?.id ?? '';
    const id = Number.parseInt(idStr, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return successResponse({ result: null });
    }
    const detail = await enrichment.getSpeciesCached(id);
    if (!detail) return successResponse({ result: null });
    return successResponse({ result: deriveCareSuggestion(detail) });
  }
).use(authMiddleware());

// Lambda entrypoint: dispatch this group's routes (see middleware/router.ts).
export const handler = createRouter({
  'GET /species/search': search,
  'GET /species/{id}': detail,
  'GET /species/{id}/thumbnail': thumbnail,
  'GET /species/{id}/guide': guide,
  'GET /species/{id}/care-suggestions': careSuggestions,
});
