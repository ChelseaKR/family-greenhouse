/**
 * Climate read endpoints. Backed by the OpenWeatherMap cache; degrades to
 * an empty payload when the integration is unconfigured or budget is
 * exhausted, mirroring the species/Perenual pattern so the frontend can
 * suppress climate UI without distinguishing the failure mode.
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import createHttpError from 'http-errors';
import { z } from 'zod';
import { createHandler } from '../../middleware/handler.js';
import { createRouter } from '../../middleware/router.js';
import { authMiddleware, AuthenticatedEvent, requireHousehold } from '../../middleware/auth.js';
import { validateBody, ValidatedEvent } from '../../middleware/validation.js';
import { successResponse, cacheableResponse } from '../../utils/response.js';
import * as climate from '../../services/climate.js';
import { isConfigured } from '../../services/weather.js';
import * as householdService from '../../services/householdService.js';

// GET /households/:id/climate
// Current weather + derived care tips for the household's saved location.
// Returns an empty `tips` array (and `weather: null`) when no location is
// set, the integration is disabled, or the daily budget is exhausted —
// all three look the same to the client by design.
export const getClimate = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const householdId = event.pathParameters?.id ?? user.householdId;
    if (!householdId) throw createHttpError(400, 'Household id required');
    // The path param must match the caller's resolved household. The
    // X-Household-Id override in authMiddleware is membership-validated, so
    // this equality check is sufficient even for multi-household users
    // (mirrors households/handler.ts).
    if (householdId !== user.householdId) {
      throw createHttpError(403, 'Access denied');
    }

    const household = await householdService.getHousehold(householdId);
    if (!household) throw createHttpError(404, 'Household not found');

    if (!household.location) {
      return successResponse({
        configured: isConfigured(),
        weather: null,
        tips: [],
      });
    }

    const snapshot = await climate.getWeatherCached(household.location.lat, household.location.lon);
    const tips = snapshot ? climate.deriveClimateTips(snapshot) : [];

    return cacheableResponse(
      {
        configured: isConfigured(),
        weather: snapshot,
        tips,
      },
      // 30-minute browser/CDN cache aligned with the 1-hour upstream cache;
      // worst case the user sees half-hour-stale weather, which is fine.
      { maxAgeSeconds: 30 * 60, visibility: 'private' }
    );
  }
)
  .use(authMiddleware())
  .use(requireHousehold());

// PUT /households/:id/location
// Save (or clear) the household's location. Free-text `city` is geocoded
// on the server so we don't trust the client's lat/lon. Passing `null`
// clears the saved location.
const locationSchema = z.union([
  z.null(),
  z.object({
    city: z.string().min(1).max(120),
  }),
]);
type LocationInput = z.infer<typeof locationSchema>;

export const setLocation = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { validatedBody } = event as ValidatedEvent<LocationInput>;
    const { user } = event as AuthenticatedEvent;
    const householdId = event.pathParameters?.id ?? user.householdId;
    if (!householdId) throw createHttpError(400, 'Household id required');
    // Same cross-household guard as getClimate: the admin check below only
    // proves the caller is an admin of their OWN household — without this
    // equality check they could overwrite any other household's location.
    if (householdId !== user.householdId) {
      throw createHttpError(403, 'Access denied');
    }
    if (user.householdRole !== 'admin') {
      throw createHttpError(403, 'Only household admins can set the location');
    }

    if (validatedBody === null) {
      const updated = await householdService.setHouseholdLocation(householdId, null);
      return successResponse(updated);
    }

    const geo = await climate.geocodeCached(validatedBody.city);
    if (!geo) {
      throw createHttpError(
        400,
        'Could not find that location. Try adding the country (e.g. "Austin, US") or a more specific spelling.'
      );
    }
    const updated = await householdService.setHouseholdLocation(householdId, {
      city: geo.city,
      lat: geo.lat,
      lon: geo.lon,
    });
    return successResponse(updated);
  }
)
  .use(authMiddleware())
  .use(requireHousehold())
  .use(validateBody(locationSchema));

// Lambda entrypoint: dispatch this group's routes (see middleware/router.ts).
export const handler = createRouter({
  'GET /households/{id}/climate': getClimate,
  'PUT /households/{id}/location': setLocation,
});
