import * as Sentry from '@sentry/react';

/**
 * Init Sentry only when VITE_SENTRY_DSN is set at build time. Staging/dev
 * builds without the env var ship a no-op. Call from main.tsx before
 * mounting React.
 */
export function initSentry(): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_GIT_SHA as string | undefined,
    tracesSampleRate: 0.1,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 1.0,
  });
}

export { Sentry };
