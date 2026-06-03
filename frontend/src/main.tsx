import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { initSentry } from './sentry';
import './i18n';
import { isRTL } from './i18n';
import { applyDensity, applyTheme, usePrefsStore } from './store/prefsStore';
// Self-hosted brand fonts. Gloock is the display face used in the wordmark
// and major headlines; Instrument Sans is the body face. Both are loaded
// at app boot from /node_modules so the page renders in-brand on first
// paint without a third-party request to Google Fonts.
import '@fontsource/gloock/400.css';
import '@fontsource-variable/instrument-sans/index.css';
import './index.css';

initSentry();

// Apply persisted preferences before React mounts so we don't get a flash of
// light theme on dark-mode users / wrong density on first paint.
{
  const prefs = usePrefsStore.getState();
  applyTheme(prefs.theme);
  applyDensity(prefs.density);
  document.documentElement.lang = prefs.language;
  document.documentElement.dir = isRTL(prefs.language) ? 'rtl' : 'ltr';
}

// Re-apply theme when the OS preference flips and the user has theme=system.
if (typeof window !== 'undefined' && window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const { theme } = usePrefsStore.getState();
    if (theme === 'system') applyTheme('system');
  });
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
