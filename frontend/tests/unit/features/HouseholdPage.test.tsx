import { describe, expect, it, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HouseholdPage } from '@/features/household/HouseholdPage';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <HouseholdPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('HouseholdPage', () => {
  beforeEach(() => {
    // A plain member (not admin) — the roster is visible to everyone in the
    // household, so this is the caller the privacy bug actually affected.
    useAuthStore.setState({
      isAuthenticated: true,
      idToken: 'id-token-1',
      refreshToken: 'refresh-1',
      user: {
        id: 'user-1',
        email: 'alice@example.com',
        name: 'Alice',
        householdId: 'hh-1',
        householdRole: 'member',
      },
    } as never);

    server.use(
      http.get(`${API}/households/hh-1`, () =>
        HttpResponse.json({
          id: 'hh-1',
          name: 'The Kelly-Reifs',
          createdAt: '',
          createdBy: 'user-1',
          members: [
            {
              userId: 'user-1',
              name: 'Alice',
              // Defense-in-depth: even if a response somehow still carried an
              // email, the page must never render it.
              email: 'alice@example.com',
              role: 'member',
              joinedAt: '',
            },
            {
              userId: 'user-2',
              name: 'Bob',
              email: 'bob@example.com',
              role: 'admin',
              joinedAt: '',
            },
          ],
        })
      ),
      http.get(`${API}/tasks/vacation`, () => HttpResponse.json([])),
      http.get(`${API}/me/households`, () =>
        HttpResponse.json([
          { householdId: 'hh-1', name: 'The Kelly-Reifs', role: 'member', joinedAt: '' },
        ])
      )
    );
  });

  it('renders member names but never their email addresses', async () => {
    renderPage();

    expect(await screen.findByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.queryByText('alice@example.com')).not.toBeInTheDocument();
    expect(screen.queryByText('bob@example.com')).not.toBeInTheDocument();
    expect(screen.queryByText(/@example\.com/)).not.toBeInTheDocument();
  });
});
