import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { CareGuideCard } from '@/features/plants/CareGuideCard';
import type { CareGuideResponse } from '@/services/speciesService';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

function renderCard(speciesId = 42) {
  useAuthStore.setState({ accessToken: 'access-1' });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <CareGuideCard perenualSpeciesId={speciesId} />
    </QueryClientProvider>
  );
}

function guide(overrides: Partial<CareGuideResponse> = {}): CareGuideResponse {
  return {
    commonName: 'Monstera',
    scientificName: 'Monstera deliciosa',
    family: 'Araceae',
    cycle: 'Perennial',
    hardinessZone: '10-12',
    indoor: true,
    poisonousToPets: true,
    sunlight: ['part shade'],
    sections: [{ type: 'watering', description: 'Water when the top inch is dry.' }],
    ...overrides,
  };
}

describe('CareGuideCard', () => {
  it('renders the guide sections when the read succeeds', async () => {
    server.use(http.get(`${API}/species/42/guide`, () => HttpResponse.json({ result: guide() })));
    renderCard();

    expect(await screen.findByText('Care guide')).toBeInTheDocument();
    expect(screen.getByText('Water when the top inch is dry.')).toBeInTheDocument();
  });

  // The defect (#350): `if (isLoading || !data) return null` made a FAILED
  // read look exactly like "this species has no guide". The card carried the
  // pet-toxicity banner at the time, so an outage silently discarded it.
  it('says the guide could not be loaded when the read fails, instead of rendering nothing', async () => {
    server.use(
      http.get(`${API}/species/42/guide`, () =>
        HttpResponse.json({ message: 'upstream down' }, { status: 502 })
      )
    );
    renderCard();

    expect(await screen.findByText(/Care guide unavailable\./)).toBeInTheDocument();
    expect(screen.queryByText('Care guide')).not.toBeInTheDocument();
  });

  it('renders nothing when the provider genuinely has no guide for the species', async () => {
    server.use(http.get(`${API}/species/42/guide`, () => HttpResponse.json({ result: null })));
    const { container } = renderCard();

    // `null` is the provider answering; it is a real empty, not a failure, and
    // must not be reported as one.
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(screen.queryByText(/Care guide unavailable\./)).not.toBeInTheDocument();
  });

  // Toxicity moved to PetToxicityNote, which PlantDetailPage mounts on its own
  // query. If it comes back here as well, a toxic plant shows the warning
  // twice and the safety fact is once again coupled to this fetch.
  it('no longer carries the pet-toxicity banner itself', async () => {
    server.use(
      http.get(`${API}/species/42/guide`, () =>
        HttpResponse.json({ result: guide({ poisonousToPets: true }) })
      )
    );
    renderCard();

    await screen.findByText('Care guide');
    expect(screen.queryByText(/Toxic to pets/i)).not.toBeInTheDocument();
  });
});
