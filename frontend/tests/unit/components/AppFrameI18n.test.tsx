import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createInstance, type i18n as I18nInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import es from '@/i18n/locales/es/translation.json';
import App from '@/App';

vi.mock('@/services/analytics', () => ({
  track: vi.fn(),
  setActiveHousehold: vi.fn(),
  identify: vi.fn(),
  setTelemetryAuthToken: vi.fn(),
  reset: vi.fn(),
}));

/**
 * The two strings the App shell itself renders on every route — the skip
 * link, and the loading status shown while a lazy route's chunk arrives —
 * were English literals, so under `es` every screen on the core path still
 * began with "Skip to main content", and the first paint of every lazy route
 * announced "Loading…". `common.loading` had been in both catalogs the whole
 * time; nothing in the shell read it.
 *
 * Rendering the real App at a lazy public route captures both: the skip link
 * is in the DOM synchronously, and the Suspense fallback is what the first
 * render shows before the route chunk resolves.
 */

let spanish: I18nInstance;

beforeAll(async () => {
  spanish = createInstance();
  await spanish.init({
    lng: 'es',
    fallbackLng: 'es',
    resources: { es: { translation: es } },
    interpolation: { escapeValue: false },
  });
});

function renderSpanishApp(path = '/login') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <I18nextProvider i18n={spanish}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>
  );
}

describe('app shell under es', () => {
  it('offers the skip link in Spanish', () => {
    renderSpanishApp();
    expect(screen.getByRole('link', { name: 'Saltar al contenido principal' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Skip to main content' })).not.toBeInTheDocument();
  });

  it('announces a loading route in Spanish', () => {
    renderSpanishApp();
    // The route chunk is lazy, so the first render is the Suspense fallback.
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Cargando…');
    expect(status).not.toHaveTextContent('Loading…');
  });
});
