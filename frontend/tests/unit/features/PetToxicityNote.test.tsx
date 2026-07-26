import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PetToxicityNote } from '@/features/plants/PetToxicityNote';
import { speciesService, type PerenualSpeciesDetail } from '@/services/speciesService';

vi.mock('@/services/speciesService', () => ({
  speciesService: {
    detailLookup: vi.fn(),
  },
}));

const detailLookup = vi.mocked(speciesService.detailLookup);

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
    detailLookup.mockResolvedValue({
      status: 'found',
      result: makeDetail({ id: 42, poisonousToPets: true }),
    });
    renderNote(42);

    expect(await screen.findByText(/keep it out of reach/i)).toBeInTheDocument();
    expect(screen.getByText('Toxic to pets')).toBeInTheDocument();
  });

  it('renders nothing when the selected species is not toxic to pets', async () => {
    detailLookup.mockResolvedValue({
      status: 'found',
      result: makeDetail({ id: 7, poisonousToPets: false }),
    });
    renderNote(7);

    // Wait for the detail fetch to settle before asserting absence.
    await waitFor(() => expect(detailLookup).toHaveBeenCalledWith(7));
    expect(screen.queryByText(/keep it out of reach/i)).not.toBeInTheDocument();
  });

  it('shows a conservative unknown warning when Perenual has no toxicity field', async () => {
    detailLookup.mockResolvedValue({
      status: 'found',
      result: makeDetail({ id: 9, poisonousToPets: null }),
    });
    renderNote(9);

    expect(await screen.findByText(/pet toxicity unknown/i)).toBeInTheDocument();
    expect(screen.getByText(/treat it as potentially unsafe/i)).toBeInTheDocument();
    expect(screen.getByText(/keep it out of reach/i)).toBeInTheDocument();
    expect(screen.queryByText(/couldn.?t check/i)).not.toBeInTheDocument();
  });

  it('shows the same conservative unknown warning for a genuine species no-result', async () => {
    detailLookup.mockResolvedValue({ status: 'not_found', result: null });
    renderNote(10);

    expect(await screen.findByText(/pet toxicity unknown/i)).toBeInTheDocument();
    expect(screen.getByText(/keep it out of reach/i)).toBeInTheDocument();
  });

  it.each(['unconfigured', 'budget_exhausted', 'upstream_error'] as const)(
    'shows an honest retryable notice when detail is unavailable because of %s',
    async (reason) => {
      detailLookup.mockResolvedValue({
        status: 'unavailable',
        reason,
        result: null,
      });
      renderNote(11);

      expect(await screen.findByText(/couldn.?t check pet toxicity/i)).toBeInTheDocument();
      expect(screen.getByText(/keep it out of reach/i)).toBeInTheDocument();
      expect(screen.queryByText(/pet toxicity unknown/i)).not.toBeInTheDocument();
    }
  );

  it('shows an honest "couldn\'t check" notice on a fetch failure, instead of looking like confirmed-safe', async () => {
    detailLookup.mockRejectedValue(new Error('network error'));
    renderNote(11);

    expect(await screen.findByText(/couldn.?t check pet toxicity/i)).toBeInTheDocument();
    expect(screen.getByText(/keep it out of reach/i)).toBeInTheDocument();
    expect(detailLookup).toHaveBeenCalledTimes(1);
  });

  it('does not fetch or render when no species is picked', () => {
    renderNote(null);

    expect(detailLookup).not.toHaveBeenCalled();
    expect(screen.queryByText(/keep it out of reach/i)).not.toBeInTheDocument();
  });
});
