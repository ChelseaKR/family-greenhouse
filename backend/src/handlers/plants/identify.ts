import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import createHttpError from 'http-errors';
import { z } from 'zod';
import { createHandler } from '../../middleware/handler.js';
import { authMiddleware, AuthenticatedEvent } from '../../middleware/auth.js';
import { validateBody, ValidatedEvent } from '../../middleware/validation.js';
import { userRateLimit } from '../../middleware/rateLimit.js';
import * as plantIdentification from '../../services/plantIdentification.js';
import * as identifyBudget from '../../services/identifyBudget.js';
import * as billing from '../../services/billing.js';
import { getPlan } from '../../models/plans.js';
import { successResponse } from '../../utils/response.js';

// We accept a data URL or a bare base64 string. The Plant.id SDK accepts both.
// Cap the body size at the middleware level (256 KiB) — clients should resize
// to <200 KiB before posting.
const identifySchema = z.object({
  image: z.string().min(64).max(350_000, 'Image too large; resize to under 256 KB'),
});

type IdentifyInput = z.infer<typeof identifySchema>;

function stripDataUrlPrefix(s: string): string {
  const m = /^data:image\/[a-z]+;base64,(.+)$/i.exec(s);
  return m ? m[1] : s;
}

// POST /plants/identify
export const identify = createHandler(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const { user } = event as AuthenticatedEvent;
    const { validatedBody } = event as ValidatedEvent<IdentifyInput>;
    const base64 = stripDataUrlPrefix(validatedBody.image);

    // Monthly metering. The route has no requireHousehold (onboarding users
    // can identify before joining a household), so householdless callers get
    // a personal bucket on the free-tier allowance. Usage is ALWAYS tracked
    // and returned; blocking only happens when IDENTIFY_METERING_ENABLED=1
    // (default off — beta is unaffected).
    const bucketId = user.householdId ?? `user:${user.userId}`;
    const plan = user.householdId
      ? getPlan((await billing.getHouseholdSubscription(user.householdId)).planId)
      : getPlan('seedling');
    const allowance = identifyBudget.allowanceForPlan(plan.id);
    const meteringEnabled = identifyBudget.meteringEnabled();
    const used = await identifyBudget.getUsage(bucketId);

    if (meteringEnabled && used >= allowance) {
      // Mirrors the plant-cap 402 contract: plan name + upgrade pointer.
      throw createHttpError(
        402,
        `Your ${plan.name} plan is limited to ${allowance} plant identifications per month. Upgrade for a higher monthly allowance.`
      );
    }

    let result: plantIdentification.IdentifyResponse;
    try {
      result = await plantIdentification.identifyPlant(base64);
    } catch (err) {
      // 5xx messages are hidden by http-error-handler unless explicitly
      // exposed; this one is intentionally surfaced so the frontend can show
      // why identification failed (e.g. upstream 503 / timeout).
      throw createHttpError(502, `Plant identification failed: ${(err as Error).message}`, {
        expose: true,
      });
    }

    // Count only calls that actually consumed a Plant.id identification —
    // the "not configured" fallback costs nothing upstream. The increment is
    // fail-soft (null on DDB error): the user already got their result.
    let finalUsed = used;
    if (result.configured) {
      finalUsed = (await identifyBudget.incrementUsage(bucketId)) ?? used + 1;
    }

    return successResponse({
      ...result,
      usage: { used: finalUsed, allowance, meteringEnabled },
    });
  }
)
  .use(authMiddleware())
  // Each call costs a metered Plant.id identification; 10/min per user is
  // far above any legitimate "retake the photo" loop but caps a runaway
  // client's spend.
  .use(userRateLimit({ perWindowMs: 60_000, max: 10 }))
  .use(validateBody(identifySchema));
