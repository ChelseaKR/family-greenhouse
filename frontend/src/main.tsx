// FIRST, and it must stay first: this hooks window.onerror before any other
// module body runs, so a top-level throw in the imports below is reportable.
// See frontend/src/telemetryBoot.ts and issue #576.
import './telemetryBoot';
import '@/lib/zodConfig';
import React from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { initSentry } from './sentry';
import { initPwaRegistration } from './services/pwaRegistration';
import './i18n';
import { isRTL } from './i18n';
import { applyDensity, usePrefsStore } from './store/prefsStore';
import { useAuthStore } from './store/authStore';
// Self-hosted brand fonts. Bitter Variable is the display face used in the
// wordmark and major headlines; Instrument Sans is the body face. Both are loaded
// at app boot from /node_modules so the page renders in-brand on first
// paint without a third-party request to Google Fonts.
import '@fontsource-variable/bitter/index.css';
import '@fontsource-variable/bitter/wght-italic.css';
import '@fontsource-variable/instrument-sans/index.css';
import './index.css';

// Fire-and-forget: Sentry (when a DSN is configured) loads as a lazy chunk
// after mount; errors before it loads are caught by the route error boundary.
void initSentry();
initPwaRegistration();

// Apply persisted preferences before React mounts so we don't get the wrong
// density / language direction on first paint.
// Note: dark mode was removed until components get real dark variants
// (frontend-audit 2026-06-12, item 6), so the app always renders light.
{
  const prefs = usePrefsStore.getState();
  applyDensity(prefs.density);
  document.documentElement.lang = prefs.language;
  document.documentElement.dir = isRTL(prefs.language) ? 'rtl' : 'ltr';
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const rootElement = document.getElementById('root')!;

const app = (
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);

/**
 * Hydrate the prerendered markup when — and only when — it is markup for the
 * URL actually being loaded and for the auth state we are about to render in.
 *
 * scripts/prerender.mjs stamps each page with `data-prerendered="<path>"`. Two
 * cases must NOT hydrate, because React would find markup that doesn't match
 * what it renders, log a hydration error, and throw the whole tree away:
 *
 *  1. Path mismatch. CloudFront serves app-shell.html (empty #root) for
 *     non-prerendered paths, so this normally can't happen — but if the edge
 *     config ever lags a deploy, an unrelated prerendered page could arrive
 *     here. Client-render it instead of melting down.
 *  2. `/` while signed in. The prerender runs logged out, so index.html holds
 *     the landing page; App redirects an authenticated visitor to /dashboard
 *     instead of rendering it.
 *
 * Anything else — the empty shell, a first-time visitor — falls through to the
 * plain client render this app has always done.
 */
const prerenderedPath = rootElement.dataset.prerendered;
const currentPath = window.location.pathname.replace(/(.)\/$/, '$1');
const authRedirectsAway = currentPath === '/' && useAuthStore.getState().isAuthenticated;

if (prerenderedPath !== undefined && prerenderedPath === currentPath && !authRedirectsAway) {
  hydrateRoot(rootElement, app);
} else {
  // Drop any server markup we've decided not to hydrate so React starts from a
  // clean container rather than rendering over it.
  rootElement.replaceChildren();
  createRoot(rootElement).render(app);
}
