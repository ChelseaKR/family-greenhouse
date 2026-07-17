import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SharedPlantPage } from '@/features/plants/SharedPlantPage';
import { plantService } from '@/services/plantService';
import { useAuthStore } from '@/store/authStore';
import * as analytics from '@/services/analytics';

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

  it('replaces logged-out acquisition with status and preserves existing-account sign-in', async () => {
    vi.mocked(plantService.getSharedPlant).mockResolvedValueOnce(PREVIEW);
    renderPage('graft-me');

    await screen.findByRole('heading', { name: 'Mother Monstera', level: 1 });
    expect(
      screen.queryByRole('button', { name: /grow your own cutting/i })
    ).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="/register"]')).toBeNull();
    expect(screen.getByRole('link', { name: /sign in/i })).toHaveAttribute(
      'href',
      '/login?redirect=/shared/graft-me'
    );
    expect(screen.getByText(/new account registration.*paused/i)).toBeInTheDocument();
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

  it('records graft intent before accepting a shared cutting', async () => {
    vi.mocked(plantService.getSharedPlant).mockResolvedValueOnce(PREVIEW);
    vi.mocked(plantService.acceptSharedPlant).mockResolvedValueOnce({ id: 'p2' } as never);
    const trackSpy = vi.spyOn(analytics, 'track');
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

    await userEvent.click(await screen.findByRole('button', { name: 'Add to my greenhouse' }));

    expect(trackSpy).toHaveBeenCalledWith('cutting_graft_started');
    expect(plantService.acceptSharedPlant).toHaveBeenCalledWith('abc123');
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
