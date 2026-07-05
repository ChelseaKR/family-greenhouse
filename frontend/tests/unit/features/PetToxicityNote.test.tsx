import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PetToxicityNote } from '@/features/plants/PetToxicityNote';
import { speciesService, type PerenualSpeciesDetail } from '@/services/speciesService';

vi.mock('@/services/speciesService', () => ({
  speciesService: {
    detail: vi.fn(),
  },
}));

const detail = vi.mocked(speciesService.detail);

function makeDetail(overrides: Partial<PerenualSpeciesDetail>): PerenualSpeciesDetail {
  return {
    id: 1,
    commonName: 'Test Plant',
    scientificName: 'Testus plantus',
    thumbnailUrl: null,
    family: null,
    cycle: null,
    watering: null,
    sunlight: [],
    hardinessZone: null,
    indoor: true,
    edible: false,
    poisonousToPets: false,
    defaultImageUrl: null,
    ...overrides,
  };
}

function renderNote(perenualSpeciesId: number | null) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <PetToxicityNote perenualSpeciesId={perenualSpeciesId} />
    </QueryClientProvider>
  );
}

describe('PetToxicityNote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the heads-up when the selected species is toxic to pets', async () => {
    detail.mockResolvedValue(makeDetail({ id: 42, poisonousToPets: true }));
    renderNote(42);

    expect(await screen.findByText(/keep it out of reach/i)).toBeInTheDocument();
    expect(screen.getByText('Toxic to pets')).toBeInTheDocument();
  });

  it('renders nothing when the selected species is not toxic to pets', async () => {
    detail.mockResolvedValue(makeDetail({ id: 7, poisonousToPets: false }));
    renderNote(7);

    // Wait for the detail fetch to settle before asserting absence.
    await waitFor(() => expect(detail).toHaveBeenCalledWith(7));
    expect(screen.queryByText(/keep it out of reach/i)).not.toBeInTheDocument();
  });

  it('renders nothing when Perenual has no toxicity data (never claims "safe")', async () => {
    detail.mockResolvedValue(makeDetail({ id: 9, poisonousToPets: null }));
    renderNote(9);

    await waitFor(() => expect(detail).toHaveBeenCalledWith(9));
    expect(screen.queryByText(/keep it out of reach/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/couldn.?t check/i)).not.toBeInTheDocument();
  });

  it('shows an honest "couldn\'t check" notice on a fetch failure, instead of looking like confirmed-safe', async () => {
    detail.mockRejectedValue(new Error('network error'));
    renderNote(11);

    expect(await screen.findByText(/couldn.?t check pet toxicity/i)).toBeInTheDocument();
    expect(screen.queryByText(/keep it out of reach/i)).not.toBeInTheDocument();
  });

  it('does not fetch or render when no species is picked', () => {
    renderNote(null);

    expect(detail).not.toHaveBeenCalled();
    expect(screen.queryByText(/keep it out of reach/i)).not.toBeInTheDocument();
  });
});
