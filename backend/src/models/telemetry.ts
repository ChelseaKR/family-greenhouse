import { z } from 'zod';

const telemetryRoute = z
  .string()
  .trim()
  .min(1)
  .max(180)
  .regex(/^\/(?:[A-Za-z0-9_.:-]+\/?)*$/u);
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
