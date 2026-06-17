import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SharedPlantPage } from '@/features/plants/SharedPlantPage';
import { plantService } from '@/services/plantService';
import { useAuthStore } from '@/store/authStore';
import { getPendingShareCode } from '@/features/plants/pendingShareCode';

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

// Surfaces the current pathname so we can assert post-CTA navigation.
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

function renderPage(code = 'abc123') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/shared/${code}`]}>
        <LocationProbe />
        <Routes>
          <Route path="/shared/:code" element={<SharedPlantPage />} />
          <Route path="/register" element={<div>register page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('SharedPlantPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    useAuthStore.setState({ isAuthenticated: false, user: null } as never);
  });

  it('renders a share-worthy cutting card leading with the plant + provenance', async () => {
    vi.mocked(plantService.getSharedPlant).mockResolvedValueOnce(PREVIEW);
    renderPage();

    // The plant name leads, as the page heading.
    expect(
      await screen.findByRole('heading', { name: 'Mother Monstera', level: 1 })
    ).toBeInTheDocument();
    expect(screen.getByText('Monstera deliciosa')).toBeInTheDocument();
    // PII-safe provenance: the household DISPLAY name, never an email.
    expect(screen.getByText('Grown by The Kelly House, passed on to you.')).toBeInTheDocument();
    expect(screen.getByText('East window, water weekly')).toBeInTheDocument();
    expect(screen.getByText('tropical')).toBeInTheDocument();
    // Never leaks anything email-shaped.
    expect(screen.queryByText(/@/)).not.toBeInTheDocument();
  });

  it('sets dynamic OG meta tags for JS-capable scrapers, falling back to the branded image', async () => {
    vi.mocked(plantService.getSharedPlant).mockResolvedValueOnce(PREVIEW);
    renderPage();

    await screen.findByRole('heading', { name: 'Mother Monstera', level: 1 });

    const ogTitle = document.querySelector('meta[property="og:title"]');
    const ogImage = document.querySelector('meta[property="og:image"]');
    expect(ogTitle?.getAttribute('content')).toContain('Mother Monstera');
    // No public photo on this preview → branded static fallback.
    expect(ogImage?.getAttribute('content')).toBe('/brand/og-image.png');
  });

  it('graft CTA stashes the share code and routes a logged-out visitor into signup', async () => {
    vi.mocked(plantService.getSharedPlant).mockResolvedValueOnce(PREVIEW);
    renderPage('graft-me');

    const cta = await screen.findByRole('button', { name: /grow your own cutting/i });
    await userEvent.click(cta);

    // Share code is carried across the signup hops, and we land in register.
    expect(getPendingShareCode()).toBe('graft-me');
    expect(screen.getByTestId('location').textContent).toBe('/register?redirect=/shared/graft-me');
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

    expect(
      await screen.findByRole('heading', { name: 'Mother Monstera', level: 1 })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add to my greenhouse' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /grow your own cutting/i })
    ).not.toBeInTheDocument();
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
