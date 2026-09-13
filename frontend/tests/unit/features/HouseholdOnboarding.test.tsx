import { describe, expect, it, beforeAll, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createInstance, type i18n as I18nInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import es from '@/i18n/locales/es/translation.json';
import { HouseholdOnboarding } from '@/features/household/HouseholdOnboarding';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

/**
 * The screen a new account lands on straight after confirming its email —
 * the first thing anyone does inside the product, and the last place a
 * broken state should be cheap to ship.
 *
 * Three defects measured on the local dev server on 2026-09-13:
 *  1. A household name of three spaces was accepted and created, leaving the
 *     switcher above the sidebar blank on every screen afterwards.
 *  2. "Join an existing household" was a dead end — the step before it says
 *     "paste their link", and the step itself offered nothing to paste into.
 *  3. Choosing a step moved focus to <body>, because the button that was
 *     pressed is unmounted by the step change.
 * And the whole screen rendered in English under `es`.
 */
function renderOnboarding(options: { i18n?: I18nInstance } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/onboarding']}>
        <Routes>
          <Route path="/onboarding" element={<HouseholdOnboarding />} />
          <Route path="/join/:inviteCode" element={<div>invite screen</div>} />
          <Route path="/" element={<div>Home</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return render(
    options.i18n ? <I18nextProvider i18n={options.i18n}>{tree}</I18nextProvider> : tree
  );
}

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

describe('HouseholdOnboarding', () => {
  beforeEach(() => {
    useAuthStore.setState({
      isAuthenticated: true,
      idToken: 'id-1',
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      user: {
        id: 'u-1',
        email: 'someone@example.invalid',
        householdId: null,
        householdRole: null,
      },
    } as never);
  });

  it('refuses a household name that is only whitespace', async () => {
    let posted = 0;
    server.use(
      http.post(`${API}/households`, () => {
        posted += 1;
        return HttpResponse.json({ id: 'hh-1', name: '   ' }, { status: 201 });
      })
    );
    const user = userEvent.setup();
    renderOnboarding();

    await user.click(await screen.findByRole('button', { name: /create a new household/i }));
    await user.type(await screen.findByLabelText(/household name/i), '   ');
    await user.click(screen.getByRole('button', { name: /^create household$/i }));

    expect(await screen.findByText('Household name is required')).toBeInTheDocument();
    expect(posted, 'a blank name must never reach POST /households').toBe(0);
  });

  it('takes a pasted invite link to the invite screen', async () => {
    const user = userEvent.setup();
    renderOnboarding();

    await user.click(await screen.findByRole('button', { name: /join an existing household/i }));
    await user.type(
      await screen.findByLabelText(/invite link or code/i),
      'https://familygreenhouse.net/join/abc123def456'
    );
    await user.click(screen.getByRole('button', { name: /open the invite/i }));

    expect(await screen.findByText('invite screen')).toBeInTheDocument();
  });

  it('says so instead of navigating when the pasted text is not an invite', async () => {
    const user = userEvent.setup();
    renderOnboarding();

    await user.click(await screen.findByRole('button', { name: /join an existing household/i }));
    await user.type(await screen.findByLabelText(/invite link or code/i), 'not a link');
    await user.click(screen.getByRole('button', { name: /open the invite/i }));

    expect(await screen.findByText(/doesn’t look like an invite link/i)).toBeInTheDocument();
    expect(screen.queryByText('invite screen')).not.toBeInTheDocument();
  });

  it('moves focus to the heading when the step changes', async () => {
    const user = userEvent.setup();
    renderOnboarding();

    await user.click(await screen.findByRole('button', { name: /create a new household/i }));

    await waitFor(() => {
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement).toBe(
        screen.getByRole('heading', { name: /create your household/i })
      );
    });
  });

  it('renders in Spanish for a visitor who selected it', async () => {
    renderOnboarding({ i18n: spanish });

    expect(await screen.findByRole('heading', { name: 'Configura tu hogar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Crear un hogar nuevo/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Unirte a un hogar existente/ })).toBeInTheDocument();
    expect(screen.queryByText('Set up your household')).not.toBeInTheDocument();
    expect(screen.queryByText('Create a new household')).not.toBeInTheDocument();
  });
});
