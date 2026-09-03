import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { axe, toHaveNoViolations } from 'jest-axe';
import { http, HttpResponse } from 'msw';
import { WelcomeFlow } from '@/features/onboarding/WelcomeFlow';
import { useAuthStore } from '@/store/authStore';
import { usePrefsStore } from '@/store/prefsStore';
import { server } from '../../msw/server';

expect.extend(toHaveNoViolations);

// jest-axe augments jest's matchers, not vitest's — declare the matcher so
// `toHaveNoViolations()` type-checks under vitest's `expect`.
declare module 'vitest' {
  interface Assertion {
    toHaveNoViolations(): void;
  }
}

const API = 'http://localhost:4000';
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const run = (el: HTMLElement) => axe(el, { runOnly: { type: 'tag', values: WCAG_TAGS } });

function renderFirstRun() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/welcome']}>
        <Routes>
          <Route path="/welcome" element={<WelcomeFlow />} />
          <Route path="/dashboard" element={<h1>Dashboard</h1>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  useAuthStore.setState({
    user: {
      id: 'u1',
      email: 'chelsea@example.com',
      name: 'Chelsea',
      householdId: 'hh-1',
      householdRole: 'admin',
    },
    idToken: 'id-1',
    isAuthenticated: true,
    isLoading: false,
  } as never);
  usePrefsStore.setState({ welcomeSeen: false });
  server.use(
    http.get(`${API}/plants`, () => HttpResponse.json([])),
    http.get(`${API}/me/households`, () =>
      HttpResponse.json([{ householdId: 'hh-1', name: 'Home', role: 'admin', joinedAt: '' }])
    ),
    http.get(`${API}/tasks/templates`, () => HttpResponse.json([])),
    http.post(`${API}/households/hh-1/invites`, () =>
      HttpResponse.json({
        code: 'INV123',
        url: 'https://familygreenhouse.net/join/INV123',
        expiresAt: '2026-09-30T00:00:00.000Z',
      })
    )
  );
});

/**
 * Structural a11y on the first run — the first authenticated screen a paying
 * customer ever sees, and the one place where a broken heading or an unlabeled
 * control costs a signup rather than an annoyance.
 */
describe('first-run accessibility (structural)', () => {
  it('the first-plant step has no violations', async () => {
    const { container } = renderFirstRun();
    await screen.findByRole('heading', { name: /add your first plant/i });
    expect(await run(container)).toHaveNoViolations();
  });

  it('the invite step has no violations, link field included', async () => {
    const user = userEvent.setup();
    const { container } = renderFirstRun();

    await user.click(await screen.findByRole('button', { name: /skip for now/i }));
    await user.click(await screen.findByRole('button', { name: /create an invite link/i }));
    await screen.findByLabelText(/invite link/i);

    expect(await run(container)).toHaveNoViolations();
  });
});
