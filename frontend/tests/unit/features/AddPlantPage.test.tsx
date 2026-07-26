import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AddPlantPage } from '@/features/plants/AddPlantPage';
import { plantService } from '@/services/plantService';
import { speciesService, type SpeciesSearchResponse } from '@/services/speciesService';
import { taskService } from '@/services/taskService';

vi.mock('@/services/plantService', () => ({
  plantService: {
    identifyPlant: vi.fn(),
    getPlants: vi.fn(),
    createPlant: vi.fn(),
    getImageUploadUrl: vi.fn(),
    uploadImage: vi.fn(),
    confirmImageUpload: vi.fn(),
  },
}));

vi.mock('@/services/speciesService', () => ({
  speciesService: {
    search: vi.fn(),
    detail: vi.fn(),
    detailLookup: vi.fn(),
    careSuggestions: vi.fn(),
  },
}));

vi.mock('@/services/taskService', () => ({
  taskService: {
    listTemplates: vi.fn(),
    applyTemplate: vi.fn(),
    createTask: vi.fn(),
  },
  suggestTaskTemplate: vi.fn(),
}));

// jsdom has no real image decoder, so the canvas pipeline never resolves —
// mock the module to behave like the "pipeline unavailable" fallback path
// (null), which is what downscaleImage itself returns in that case.
vi.mock('@/utils/image', () => ({
  downscaleImage: vi.fn().mockResolvedValue(null),
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
      <MemoryRouter initialEntries={['/plants/new']}>
        <Routes>
          <Route path="/plants/new" element={<AddPlantPage />} />
          <Route path="/plants/:plantId" element={<DetailDestination />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function DetailDestination() {
  const location = useLocation();
  const navigate = useNavigate();
  const photoUploadFailed =
    (location.state as { photoUploadFailed?: boolean } | null)?.photoUploadFailed === true;
  return (
    <div>
      <h1>Plant detail destination</h1>
      {photoUploadFailed && <p>Photo upload recovery requested</p>}
      <button type="button" onClick={() => navigate(-1)}>
        Back in history
      </button>
    </div>
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
    vi.mocked(taskService.listTemplates).mockResolvedValue([]);
    vi.mocked(plantService.getPlants).mockResolvedValue([]);
    vi.mocked(plantService.uploadImage).mockResolvedValue(undefined);
    vi.mocked(plantService.confirmImageUpload).mockResolvedValue(undefined);
  });

  it('does not let a slower earlier pick clobber a faster later one', async () => {
    const monsteraSearch = deferred<SpeciesSearchResponse>();
    const fernSearch = deferred<SpeciesSearchResponse>();
    vi.mocked(speciesService.search).mockImplementation((query: string) => {
      if (query === 'Monstera deliciosa') return monsteraSearch.promise;
      if (query === 'Nephrolepis exaltata') return fernSearch.promise;
      return Promise.resolve({ source: 'perenual', results: [] });
    });
    vi.mocked(speciesService.detailLookup).mockImplementation((id: number) =>
      Promise.resolve({
        status: 'found',
        result: {
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
        },
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
    await waitFor(() => expect(speciesService.detailLookup).toHaveBeenCalledWith(2));

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
    expect(speciesService.detailLookup).not.toHaveBeenCalledWith(1);
    expect(screen.queryByText('Toxic to pets')).not.toBeInTheDocument();
  });

  it('explains that photo identification is unavailable when the provider is not configured', async () => {
    vi.mocked(plantService.identifyPlant).mockResolvedValue({
      configured: false,
      suggestions: [],
    });
    renderPage();

    const user = userEvent.setup();
    const file = new File(['plant-bytes'], 'plant.jpg', { type: 'image/jpeg' });
    await user.upload(screen.getByLabelText(/choose a photo/i), file);
    await user.click(await screen.findByRole('button', { name: /identify from photo/i }));

    expect(
      await screen.findByText(
        'Photo identification is unavailable right now. You can still enter the species manually.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use' })).not.toBeInTheDocument();
    expect(screen.queryByText(/No suggestions came back/i)).not.toBeInTheDocument();
  });

  it('keeps a committed plant and routes to photo recovery without creating it twice', async () => {
    vi.mocked(plantService.createPlant).mockResolvedValue({
      id: 'plant-created',
      householdId: 'household-1',
      name: 'Saved Fern',
      species: null,
      location: null,
      spaceId: null,
      placementNote: null,
      summerSpaceId: null,
      winterSpaceId: null,
      imageUrl: null,
      notes: null,
      status: 'active',
      statusChangedAt: null,
      tags: [],
      perenualSpeciesId: null,
      parentPlantId: null,
      createdAt: '2026-04-25T00:00:00.000Z',
      createdBy: 'user-1',
      updatedAt: '2026-04-25T00:00:00.000Z',
    });
    vi.mocked(plantService.getImageUploadUrl).mockResolvedValue({
      uploadUrl: 'https://uploads.example/photo',
      imageUrl: 'https://images.example/photo.jpg',
    });
    vi.mocked(plantService.uploadImage).mockRejectedValueOnce(new Error('Upload unavailable'));
    const user = userEvent.setup();
    renderPage();

    await user.upload(
      screen.getByLabelText(/choose a photo/i),
      new File(['plant-photo'], 'fern.jpg', { type: 'image/jpeg' })
    );
    await user.type(screen.getByLabelText(/plant name/i), 'Saved Fern');
    await user.click(screen.getByRole('button', { name: /add plant/i }));

    expect(await screen.findByRole('heading', { name: 'Plant detail destination' })).toBeVisible();
    expect(screen.getByText('Photo upload recovery requested')).toBeVisible();
    expect(plantService.createPlant).toHaveBeenCalledTimes(1);
    expect(plantService.confirmImageUpload).not.toHaveBeenCalled();

    // The failed upload navigation replaces the submitted form. Going Back
    // cannot expose it for a duplicate resubmission.
    await user.click(screen.getByRole('button', { name: /back in history/i }));
    expect(screen.getByRole('heading', { name: 'Plant detail destination' })).toBeVisible();
    expect(plantService.createPlant).toHaveBeenCalledTimes(1);
  });
});
