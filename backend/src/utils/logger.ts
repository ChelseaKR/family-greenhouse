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
