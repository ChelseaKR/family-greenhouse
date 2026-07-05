import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AddPlantPage } from '@/features/plants/AddPlantPage';
import { plantService } from '@/services/plantService';
import { speciesService, type SpeciesSearchResponse } from '@/services/speciesService';

vi.mock('@/services/plantService', () => ({
  plantService: {
    identifyPlant: vi.fn(),
  },
}));

vi.mock('@/services/speciesService', () => ({
  speciesService: {
    search: vi.fn(),
    detail: vi.fn(),
    careSuggestions: vi.fn(),
  },
}));

/** A promise this test can resolve on demand, to control resolution order. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AddPlantPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

async function pickPhotoAndIdentify() {
  const file = new File(['plant-bytes'], 'plant.jpg', { type: 'image/jpeg' });
  const input = screen.getByLabelText(/choose a photo/i);
  const user = userEvent.setup();
  await user.upload(input, file);
  fireEvent.click(await screen.findByRole('button', { name: /identify from photo/i }));
  await screen.findAllByRole('button', { name: 'Use' });
}

describe('AddPlantPage acceptSuggestion race guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(plantService.identifyPlant).mockResolvedValue({
      configured: true,
      suggestions: [
        { scientificName: 'Monstera deliciosa', commonName: 'Monstera', probability: 0.9 },
        { scientificName: 'Nephrolepis exaltata', commonName: 'Boston fern', probability: 0.8 },
      ],
    });
    vi.mocked(speciesService.careSuggestions).mockResolvedValue(null);
  });

  it('does not let a slower earlier pick clobber a faster later one', async () => {
    const monsteraSearch = deferred<SpeciesSearchResponse>();
    const fernSearch = deferred<SpeciesSearchResponse>();
    vi.mocked(speciesService.search).mockImplementation((query: string) => {
      if (query === 'Monstera deliciosa') return monsteraSearch.promise;
      if (query === 'Nephrolepis exaltata') return fernSearch.promise;
      return Promise.resolve({ source: 'perenual', results: [] });
    });
    vi.mocked(speciesService.detail).mockImplementation((id: number) =>
      Promise.resolve({
        id,
        commonName: id === 1 ? 'Monstera' : 'Boston fern',
        scientificName: id === 1 ? 'Monstera deliciosa' : 'Nephrolepis exaltata',
        thumbnailUrl: null,
        family: null,
        cycle: null,
        watering: null,
        sunlight: [],
        hardinessZone: null,
        indoor: true,
        edible: false,
        // Monstera (id 1) is toxic; Boston fern (id 2) is not — lets the
        // test tell which one "won" from the rendered alert alone.
        poisonousToPets: id === 1,
        defaultImageUrl: null,
      })
    );

    renderPage();
    await pickPhotoAndIdentify();

    // Click "Use" on Monstera (the slower search) first.
    const [useMonstera] = screen.getAllByRole('button', { name: 'Use' });
    fireEvent.click(useMonstera);
    await waitFor(() => expect(speciesService.search).toHaveBeenCalledWith('Monstera deliciosa'));

    // Re-identify the same photo (list reappears) and pick Boston fern.
    fireEvent.click(await screen.findByRole('button', { name: /identify from photo/i }));
    await screen.findAllByRole('button', { name: 'Use' });
    const [, useFern] = screen.getAllByRole('button', { name: 'Use' });
    fireEvent.click(useFern);
    await waitFor(() => expect(speciesService.search).toHaveBeenCalledWith('Nephrolepis exaltata'));

    // The faster (later) pick resolves first and should win.
    fernSearch.resolve({
      source: 'perenual',
      results: [
        {
          id: 2,
          commonName: 'Boston fern',
          scientificName: 'Nephrolepis exaltata',
          thumbnailUrl: null,
        },
      ],
    });
    await waitFor(() => expect(speciesService.detail).toHaveBeenCalledWith(2));

    // The slower (earlier) pick resolves after — it's stale and must be
    // ignored, since the species field has already moved on to the fern.
    // Give the stale resolution a chance to (wrongly) apply if the guard
    // were missing, then assert it never did.
    await act(async () => {
      monsteraSearch.resolve({
        source: 'perenual',
        results: [
          {
            id: 1,
            commonName: 'Monstera',
            scientificName: 'Monstera deliciosa',
            thumbnailUrl: null,
          },
        ],
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(speciesService.detail).not.toHaveBeenCalledWith(1);
    expect(screen.queryByText('Toxic to pets')).not.toBeInTheDocument();
  });
});
