import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SharedPlantPage } from '@/features/plants/SharedPlantPage';
import { plantService } from '@/services/plantService';
import { useAuthStore } from '@/store/authStore';
import * as analytics from '@/services/analytics';
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
    // The house rule — the one line of the household's own care words a
    // public cutting card carries. Its free-text notes are not in the payload
    // at all (backend: PlantShareSnapshot).
    careRule: 'Bottom-water only',
    imageUrl: null,
    tags: ['tropical'],
  },
  householdName: 'The Kelly House',
  expiresAt: '2099-01-01T00:00:00.000Z',
};

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
          <Route path="/register" element={<div>Register page</div>} />
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
    expect(screen.getByText('Bottom-water only')).toBeInTheDocument();
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

  it('carries logged-out visitors into free signup with the graft redirect', async () => {
    vi.mocked(plantService.getSharedPlant).mockResolvedValueOnce(PREVIEW);
    renderPage('graft-me');

    const cta = await screen.findByRole('button', { name: /grow your own cutting/i });
    await userEvent.click(cta);

    expect(getPendingShareCode()).toBe('graft-me');
    expect(screen.getByTestId('location')).toHaveTextContent('/register?redirect=/shared/graft-me');
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
    // The server said the link is gone, so there is nothing to retry.
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  // Audit 2026-11-08, finding 6: every failed read used to render as "This
  // share link is invalid or has expired", so a 503 or a dropped connection
  // told someone holding a good link to go and ask for a new one.
  describe('a read that failed is not an invalid link', () => {
    const INVALID = 'This share link is invalid or has expired.';
    const LOAD_FAILED = 'We couldn’t load this cutting just now. Try again in a moment.';

    it.each([
      [
        'a 503',
        Object.assign(new Error('Request failed with status code 503'), {
          response: { status: 503, data: { message: 'Service Unavailable' } },
        }),
      ],
      [
        'a 500',
        Object.assign(new Error('Request failed with status code 500'), {
          response: { status: 500, data: { message: 'Internal Server Error' } },
        }),
      ],
      // No `response` at all: offline, the API unreachable, or a timeout.
      ['a dropped connection', Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' })],
      [
        'a timeout',
        Object.assign(new Error('timeout of 15000ms exceeded'), { code: 'ECONNABORTED' }),
      ],
    ])(
      'says the cutting could not be loaded on %s, not that the link is bad',
      async (_, failure) => {
        vi.mocked(plantService.getSharedPlant).mockRejectedValueOnce(failure);
        renderPage('good-link');

        expect(await screen.findByText(LOAD_FAILED)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
        expect(screen.queryByText(INVALID)).not.toBeInTheDocument();
        // "Ask the sender for a fresh link" is advice for a dead link only.
        expect(screen.queryByText(/Ask the sender for a fresh link/)).not.toBeInTheDocument();
      }
    );

    it('reads the link again on Try again and shows the cutting once the read succeeds', async () => {
      vi.mocked(plantService.getSharedPlant)
        .mockRejectedValueOnce(Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' }))
        .mockResolvedValueOnce(PREVIEW);
      renderPage('good-link');

      await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));

      expect(
        await screen.findByRole('heading', { name: 'Mother Monstera', level: 1 })
      ).toBeInTheDocument();
      expect(plantService.getSharedPlant).toHaveBeenCalledTimes(2);
      expect(screen.queryByText(LOAD_FAILED)).not.toBeInTheDocument();
    });

    it('says invalid or expired when the retry is answered 404', async () => {
      vi.mocked(plantService.getSharedPlant)
        .mockRejectedValueOnce(Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' }))
        .mockRejectedValueOnce(
          Object.assign(new Error('Request failed'), {
            response: {
              status: 404,
              data: { message: 'This share link is invalid or has expired' },
            },
          })
        );
      renderPage('expired2');

      await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));

      expect(await screen.findByText(INVALID)).toBeInTheDocument();
      expect(screen.queryByText(LOAD_FAILED)).not.toBeInTheDocument();
    });
  });
});
