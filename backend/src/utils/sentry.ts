/**
 * Lazy Sentry integration. @sentry/aws-serverless is a heavy dependency and
 * this module is imported (via middleware/router.ts) by EVERY handler bundle,
 * so we must not import it statically — that would tax every cold start even
 * in environments that never set SENTRY_DSN. Instead the SDK is dynamically
 * imported on the first invocation, and only when SENTRY_DSN is set.
 *
 * The exported API surface (initSentry / instrument) is unchanged so callers
 * like middleware/router.ts keep working as-is.
 */
type SentryModule = typeof import('@sentry/aws-serverless');

let sentryPromise: Promise<SentryModule | null> | null = null;

/**
 * Initialize Sentry once per Lambda cold start, only when SENTRY_DSN is set.
 * Production deploys flip this on by setting the env var; staging/dev stay
 * silent unless explicitly opted in. Resolves to the SDK module (initialized)
 * or null when Sentry is disabled/unavailable.
 */
export function initSentry(): Promise<SentryModule | null> {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return Promise.resolve(null);
  if (!sentryPromise) {
    sentryPromise = import('@sentry/aws-serverless')
      .then((Sentry) => {
        Sentry.init({
          dsn,
          environment: process.env.STAGE || process.env.NODE_ENV || 'dev',
          tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0.1'),
          release: process.env.GIT_SHA,
        });
        return Sentry;
      })
      .catch((err) => {
        // Sentry being unavailable must never take the function down.
        console.error('sentry_init_failed', err);
        return null;
      });
  }
  return sentryPromise;
}

/**
 * Wrap a Lambda handler so unhandled exceptions are reported. No-op (returns
 * the handler unchanged) when SENTRY_DSN is unset, so disabled environments
 * pay zero cost — not even the dynamic import.
 */
export function instrument<T extends (...args: unknown[]) => unknown>(handler: T): T {
  if (!process.env.SENTRY_DSN) return handler;
  let wrappedPromise: Promise<T> | null = null;
  const lazyWrapped = ((...args: unknown[]) => {
    if (!wrappedPromise) {
      wrappedPromise = initSentry().then((sentry) =>
        sentry ? (sentry.wrapHandler(handler as never) as unknown as T) : handler
      );
    }
    return wrappedPromise.then((wrapped) => wrapped(...args));
  }) as unknown as T;
  return lazyWrapped;
}
