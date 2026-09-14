import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { http, HttpResponse } from 'msw';
import { SitterLinksCard } from '@/features/household/SitterLinksCard';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

/**
 * Copying the link IS the share step: an invite or a sitter link that is not
 * on the clipboard has not been shared with anybody. Success was reported
 * only by the button's own label flipping to "Copied!" — not a live region,
 * not announced — while the failure path already carried `role="alert"`. So
 * the one outcome a screen-reader user needed to hear was the one that said
 * nothing, on a sitter link the card states it will never show in full again.
 */
function renderSitterCard() {
  useAuthStore.setState({
    user: {
      id: 'user-1',
      email: 'me@example.invalid',
      name: 'Me',
      householdId: 'hh-1',
      householdRole: 'admin',
    },
    isAuthenticated: true,
    isLoading: false,
  } as never);
  server.use(
    http.get(`${API}/me/households`, () =>
      HttpResponse.json([{ householdId: 'hh-1', name: 'Home', role: 'admin', joinedAt: '' }])
    ),
    http.get(`${API}/plants`, () => HttpResponse.json([])),
    http.get(`${API}/households/hh-1/sitter-links`, () => HttpResponse.json([])),
    http.get(`${API}/billing/me`, () => HttpResponse.json({ planId: 'garden' })),
    http.post(`${API}/households/hh-1/sitter-links`, () =>
      HttpResponse.json(
        {
          id: 'l1',
          label: 'Neighbour',
          status: 'active',
          url: 'https://familygreenhouse.net/sit/token-1',
          startsAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        },
        { status: 201 }
      )
    )
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <SitterLinksCard householdId="hh-1" members={[]} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: false } as never);
});

describe('sitter link copy', () => {
  it('announces the copy in a live region, not only on the button', async () => {
    // userEvent installs its own clipboard stub, which is the one the
    // component writes through.
    const user = userEvent.setup();
    renderSitterCard();

    await user.click(await screen.findByRole('button', { name: /create sitter link/i }));
    const copyButton = await screen.findByRole('button', { name: /^copy$/i });
    await user.click(copyButton);

    await waitFor(() => {
      const statuses = screen.getAllByRole('status');
      const announced = statuses.some((node) =>
        within(node).queryByText(/link copied to your clipboard/i)
      );
      expect(announced, 'the copy must be announced in a live region').toBe(true);
    });
    await expect(navigator.clipboard.readText()).resolves.toBe(
      'https://familygreenhouse.net/sit/token-1'
    );
  });
});
