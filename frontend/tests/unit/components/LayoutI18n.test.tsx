import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createInstance, type i18n as I18nInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import es from '@/i18n/locales/es/translation.json';
import { Layout } from '@/components/Layout';
import { useAuthStore } from '@/store/authStore';
import * as householdService from '@/services/householdService';

vi.mock('@/services/analytics', () => ({
  track: vi.fn(),
  setActiveHousehold: vi.fn(),
  identify: vi.fn(),
  setTelemetryAuthToken: vi.fn(),
  reset: vi.fn(),
}));

/**
 * The app frame — the sidebar every authenticated screen renders inside.
 *
 * Its labels lived in a module-level `navigation` array as English string
 * literals, which the hardcoded-string ratchet cannot see: that gate reads JSX
 * text nodes and the attributes a screen reader speaks. So `nav.dashboard`,
 * `nav.plants`, `nav.tasks`, `nav.household`, `nav.settings` and `nav.signOut`
 * sat translated and unused in both catalogs while a visitor with Spanish
 * selected read "Dashboard / Plants / Tasks" on every screen, with every gate
 * green. This test renders the frame in Spanish and asserts the labels
 * resolve, which no static scan of this repo can do for a constant.
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

function renderSpanishFrame() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <I18nextProvider i18n={spanish}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/dashboard']}>
          <Routes>
            <Route element={<Layout />}>
              <Route path="/dashboard" element={<div>contenido</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>
  );
}

describe('app frame under es', () => {
  beforeEach(() => {
    vi.spyOn(householdService, 'listMyHouseholds').mockResolvedValue([
      { householdId: 'hh-1', name: 'Casa', role: 'admin', joinedAt: '' },
    ]);
    useAuthStore.setState({
      user: {
        id: 'u1',
        email: 'someone@example.invalid',
        name: 'Alguien',
        householdId: 'hh-1',
        householdRole: 'admin',
      },
      idToken: 'id-1',
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      isAuthenticated: true,
      isLoading: false,
      activeHouseholdId: null,
    });
  });

  it('renders every sidebar destination from the catalog', () => {
    renderSpanishFrame();
    for (const label of [
      'Panel',
      'Plantas',
      'Tareas',
      'Estadísticas',
      'Hogar',
      'Ajustes',
      'Ayuda',
    ]) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Cerrar sesión' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Navegación principal' })).toBeInTheDocument();
  });

  it('translates the household switcher above the nav', async () => {
    renderSpanishFrame();
    expect(await screen.findByText('Hogar activo')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Añadir un hogar/ })).toBeInTheDocument();
    expect(screen.queryByText('Active household')).not.toBeInTheDocument();
  });

  it('leaves no English navigation label behind', () => {
    renderSpanishFrame();
    // The exact strings that used to be literals in the `navigation` array.
    for (const english of ['Dashboard', 'Plants', 'Tasks', 'Analytics', 'Household', 'Settings']) {
      expect(screen.queryByRole('link', { name: english })).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
  });
});
