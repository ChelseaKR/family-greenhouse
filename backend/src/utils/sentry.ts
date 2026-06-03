import * as Sentry from '@sentry/aws-serverless';

let initialized = false;

/**
 * Initialize Sentry once per Lambda cold start, only when SENTRY_DSN is set.
 * Production deploys flip this on by setting the env var; staging/dev stay
 * silent unless explicitly opted in.
 */
export function initSentry(): typeof Sentry | null {
  if (initialized) return Sentry;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return null;
  Sentry.init({
    dsn,
    environment: process.env.STAGE || process.env.NODE_ENV || 'dev',
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0.1'),
    release: process.env.GIT_SHA,
  });
  initialized = true;
  return Sentry;
}

/**
 * Wrap a Lambda handler so unhandled exceptions are reported. No-op if Sentry
 * isn't configured.
 */
export function instrument<T extends (...args: unknown[]) => unknown>(handler: T): T {
  const sentry = initSentry();
  if (!sentry) return handler;
  return sentry.wrapHandler(handler as never) as T;
}
