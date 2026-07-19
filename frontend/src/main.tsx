import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { initSentry } from './sentry';
import { initFrontendTelemetry } from './services/frontendTelemetry';
import './i18n';
import { isRTL } from './i18n';
import { applyDensity, usePrefsStore } from './store/prefsStore';
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
initFrontendTelemetry();

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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);
