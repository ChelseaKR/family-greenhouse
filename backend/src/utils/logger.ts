import pino from 'pino';

/**
 * One Lambda-friendly logger. CloudWatch already adds timestamps and request
 * IDs at the platform level; we add structured fields for user-id, household-id
 * and our own request-id so a single user complaint can be traced across
 * multiple invocations.
 *
 * In test, we silence output so `vitest run` stays clean.
 */

/**
 * Field names censored on their way to CloudWatch.
 *
 * This is a BACKSTOP, not a licence. Nothing here says "log PII and let the
 * logger clean it up" — it exists so the next `logger.info({ ...body })` added
 * anywhere cannot ship a recipient address, a credential or an image payload
 * into a 30-day retention by accident. Before this list the only route
 * structurally protected was `handlers/api/handler.ts`'s telemetry pair, and
 * only because its schemas are `.strict()` closed enums: an accident of that
 * route's design, not a property of logging (#452).
 *
 * Each name is listed twice — bare for a top-level field (`audit()` spreads
 * its fields at the root, and the dry-run branch logged `to` there) and once
 * under a wildcard for a nested one. Verified against pino 10: an invalid path
 * throws at logger construction, which would take the whole process down, so
 * every entry here is exercised by tests/unit/utils/logger.test.ts.
 *
 * `actorEmail` is DELIBERATELY absent, and that is the recorded decision.
 * `utils/auditLog.ts`'s whole value is answering "who did this" without a
 * Cognito join, and its field name is distinct precisely so this list can
 * allow it while censoring every other email-shaped field. The consequence —
 * the Lambda log groups are an in-scope PII store whose only real mitigation
 * is the 30-day retention, so an erasure request is satisfied in 30 days
 * rather than immediately — is written down in `docs/compliance.md` and
 * `docs/observability.md` instead of being left implicit.
 */
const REDACTED_PATHS = [
  'email',
  '*.email',
  '*.*.email',
  'to',
  '*.to',
  'phone',
  '*.phone',
  'password',
  '*.password',
  'pin',
  '*.pin',
  'token',
  '*.token',
  'refreshToken',
  '*.refreshToken',
  'accessToken',
  '*.accessToken',
  'idToken',
  '*.idToken',
  'apiKey',
  '*.apiKey',
  'imageBase64',
  '*.imageBase64',
  'authorization',
  '*.authorization',
  'headers.authorization',
  'req.headers.authorization',
];

/**
 * Build a logger with the production configuration. The singleton below
 * writes to stdout (what Lambda ships to CloudWatch); tests pass an
 * in-memory destination so the *real* serialization path — single-line
 * NDJSON, level labels, base fields — is what gets asserted, not a copy
 * of the config (see tests/unit/utils/logger.test.ts).
 */
export function createLogger(destination?: pino.DestinationStream): pino.Logger {
  const options: pino.LoggerOptions = {
    level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
    base: {
      service: 'family-greenhouse',
      env: process.env.STAGE || process.env.NODE_ENV || 'dev',
    },
    // Lambda runtime captures stdout into CloudWatch already; no transports.
    formatters: {
      level: (label) => ({ level: label }),
    },
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
  };
  return destination ? pino(options, destination) : pino(options);
}

export const logger = createLogger();

export type Logger = typeof logger;

export interface RequestContext {
  requestId?: string;
  userId?: string;
  householdId?: string;
  /** X-Ray trace id (Lambda sets this in `_X_AMZN_TRACE_ID`). When present
   *  it lets us pivot from a CloudWatch log line to the X-Ray service map. */
  traceId?: string;
}

export function withRequest(ctx: RequestContext, base: Logger = logger): Logger {
  return base.child(ctx);
}

/**
 * Parse the X-Ray trace id Lambda surfaces via `_X_AMZN_TRACE_ID`. The
 * raw value looks like `Root=1-abc-def;Parent=…;Sampled=1`; we keep just
 * the root id, which is what X-Ray's "Search by trace id" expects.
 *
 * Returns `undefined` outside Lambda (local dev, tests).
 */
export function currentTraceId(): string | undefined {
  const raw = process.env._X_AMZN_TRACE_ID;
  if (!raw) return undefined;
  const root = raw.split(';').find((p) => p.startsWith('Root='));
  return root ? root.slice('Root='.length) : undefined;
}
