import { z } from 'zod';

function isTelemetryRoute(value: string): boolean {
  if (!value.startsWith('/')) return false;

  let previousWasSlash = true;
  for (let index = 1; index < value.length; index += 1) {
    const character = value[index];
    if (character === '/') {
      if (previousWasSlash) return false;
      previousWasSlash = true;
      continue;
    }

    const code = character.charCodeAt(0);
    const isAsciiLetter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    const isDigit = code >= 48 && code <= 57;
    if (!isAsciiLetter && !isDigit && !'_.:-'.includes(character)) return false;
    previousWasSlash = false;
  }

  return true;
}

const telemetryRoute = z
  .string()
  .trim()
  .min(1)
  .max(180)
  .refine(isTelemetryRoute, 'Route must be a normalized application path');
const browserErrorNames = [
  'ChunkLoadError',
  'Error',
  'EvalError',
  'NetworkError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
] as const;
const browserErrorMessages = [
  'Application update or chunk load failed',
  'Network request failed',
  ...browserErrorNames.map((name) => `${name} in browser` as const),
] as const;
const releaseId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._-]{1,80}$/u)
  .optional();

export const frontendTelemetrySchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('error'),
      sessionId: z.string().uuid(),
      route: telemetryRoute,
      name: z.enum(browserErrorNames),
      message: z.enum(browserErrorMessages),
      fingerprint: z.string().regex(/^[a-f0-9]{8,64}$/u),
      release: releaseId,
    })
    .strict(),
  z
    .object({
      kind: z.literal('vital'),
      sessionId: z.string().uuid(),
      route: telemetryRoute,
      metric: z.enum(['LCP', 'CLS', 'INP']),
      value: z.number().finite().nonnegative().max(100_000),
      rating: z.enum(['good', 'needs-improvement', 'poor']),
      release: releaseId,
    })
    .strict(),
  // Delivery reports (issue #576). Neither an error nor a measurement: a
  // statement about the reporting rail itself.
  //
  //   source: 'browser'   — this browser failed to deliver `undelivered`
  //                         reports, starting `ageMinutes` ago, and is saying
  //                         so now that delivery works again. It is the only
  //                         way "no errors were reported" and "no report could
  //                         be delivered" are distinguishable at all.
  //   source: 'synthetic' — scripts/telemetry-delivery-check.mjs, run every
  //                         15 minutes by .github/workflows/uptime.yml. A
  //                         heartbeat with a cadence that does not depend on
  //                         anyone visiting the site, which is what makes
  //                         `treat_missing_data = "breaching"` honest for the
  //                         alarm that reads it.
  //
  // This route is public and IP-rate-limited, exactly as it was for `error`
  // and `vital`: the fields below are operational hints from an untrusted
  // client, not attestations. `undelivered` is capped at 9999 and `ageMinutes`
  // at 14 days so a forged body cannot skew a metric by an unbounded amount.
  z
    .object({
      kind: z.literal('delivery'),
      source: z.enum(['browser', 'synthetic']),
      sessionId: z.string().uuid(),
      route: telemetryRoute,
      undelivered: z.number().int().nonnegative().max(9999),
      ageMinutes: z.number().int().nonnegative().max(20_160),
      release: releaseId,
    })
    .strict(),
]);

export type FrontendTelemetryInput = z.infer<typeof frontendTelemetrySchema>;

export const productEventNames = [
  'signup_completed',
  'household_created',
  'household_joined',
  'invite_sent',
  'invite_accepted',
  'plant_added',
  'plant_lifecycle_changed',
  'plants_imported',
  'plants_moved',
  'task_created',
  'task_completed',
  'task_snoozed',
  'photo_uploaded',
  'subscription_upgraded',
  'subscription_canceled',
  'data_exported',
  'plant_identified',
  'leaf_health_checked',
  'plant_shared',
  'plant_share_accepted',
  'cutting_graft_started',
  'household_switched',
  'shared_care_pulse_action',
  'climate_location_set',
  'experiment_viewed',
  'upgrade_requested',
] as const;

export const productTelemetrySchema = z
  .object({
    event: z.enum(productEventNames),
    properties: z
      .object({
        plan: z.enum(['seedling', 'garden', 'greenhouse']).optional(),
        ordinal: z.enum(['first', 'subsequent']).optional(),
        taskType: z.enum(['water', 'fertilize', 'prune', 'repot', 'custom']).optional(),
        memberCount: z.enum(['1', '2-5', '6+']).optional(),
        upgradeTo: z.enum(['garden', 'greenhouse']).optional(),
        interval: z.enum(['month', 'year', 'lifetime']).optional(),
        context: z
          .string()
          .regex(/^(?:[a-z][a-z0-9_-]{0,31}|\d{1,6})$/u)
          .optional(),
        experiment: z
          .string()
          .regex(/^[a-z][a-z0-9_-]{0,47}$/u)
          .optional(),
        variant: z.enum(['A', 'B']).optional(),
      })
      .strict()
      .default({}),
    superProperties: z
      .record(
        z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/u),
        z.string().regex(/^[A-Za-z0-9_-]{1,48}$/u)
      )
      .refine(
        (properties) => Object.keys(properties).length <= 10,
        'At most 10 properties are allowed'
      )
      .default({}),
  })
  .strict();

export type ProductTelemetryInput = z.infer<typeof productTelemetrySchema>;
