import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SharedPlantPage } from '@/features/plants/SharedPlantPage';
import { plantService } from '@/services/plantService';
import { useAuthStore } from '@/store/authStore';

vi.mock('@/services/plantService', () => ({
  plantService: {
    getSharedPlant: vi.fn(),
    acceptSharedPlant: vi.fn(),
  },
}));

const PREVIEW = {
  plant: {
    name: 'Mother Monstera',
    species: 'Monstera deliciosa',
    notes: 'East window, water weekly',
    imageUrl: null,
    tags: ['tropical'],
  },
  householdName: 'The Kelly House',
  expiresAt: '2099-01-01T00:00:00.000Z',
};

function renderPage(code = 'abc123') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/shared/${code}`]}>
        <Routes>
          <Route path="/shared/:code" element={<SharedPlantPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('SharedPlantPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the shared plant card with a sign-in CTA when logged out', async () => {
    vi.mocked(plantService.getSharedPlant).mockResolvedValueOnce(PREVIEW);
    renderPage();

    expect(await screen.findByText('Mother Monstera')).toBeInTheDocument();
    expect(screen.getByText('Monstera deliciosa')).toBeInTheDocument();
    expect(screen.getByText('East window, water weekly')).toBeInTheDocument();
    expect(screen.getByText('tropical')).toBeInTheDocument();
    expect(screen.getByText('Shared by The Kelly House')).toBeInTheDocument();

    // Logged out (default test auth state): CTA to sign in / register, no
    // accept button.
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/login?redirect=/shared/abc123'
    );
    expect(screen.getByRole('link', { name: 'Create account' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add to my greenhouse' })).not.toBeInTheDocument();
  });

  it('offers "Add to my greenhouse" when signed in with a household', async () => {
    vi.mocked(plantService.getSharedPlant).mockResolvedValueOnce(PREVIEW);
    useAuthStore.setState({
      isAuthenticated: true,
      user: {
        id: 'u1',
        email: 'me@example.com',
        name: 'Me',
        householdId: 'hh-1',
        householdRole: 'admin',
      } as never,
    });
    renderPage();

    expect(await screen.findByText('Mother Monstera')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add to my greenhouse' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Sign in' })).not.toBeInTheDocument();
  });

  it('shows the invalid/expired state on a 404', async () => {
    vi.mocked(plantService.getSharedPlant).mockRejectedValueOnce(
      Object.assign(new Error('Request failed'), {
        response: { status: 404, data: { message: 'This share link is invalid or has expired' } },
      })
    );
    renderPage('expired1');

    expect(
      await screen.findByText('This share link is invalid or has expired.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add to my greenhouse' })).not.toBeInTheDocument();
  });
});
