/**
 * Sentry, loaded only when a DSN is configured.
 *
 * `import.meta.env.VITE_SENTRY_DSN` is inlined by Vite at build time. When it's
 * unset (the current prod build has no DSN), the `if` below is dead code and
 * Rollup tree-shakes the dynamic `import('@sentry/react')` away entirely — the
 * ~35 KB SDK never ships. When a DSN *is* present at build, Sentry loads as a
 * lazy chunk fetched right after mount, so it stays out of the initial bundle.
 *
 * This replaces a static top-level `import * as Sentry` that shipped the SDK to
 * every user regardless of DSN.
 */
export async function initSentry(): Promise<void> {
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (!dsn) return;

  const Sentry = await import('@sentry/react');
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_GIT_SHA as string | undefined,
    tracesSampleRate: 0.1,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 1.0,
  });
}
