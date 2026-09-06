/**
 * The placement card carries a pet check — "this species may be toxic, and
 * this room is marked as reachable by pets". So its ABSENCE is a claim.
 *
 * For any species outside the small curated table, the `/species/:id/guide`
 * read is the only source for both of its checks. A failed read left
 * `enriched` undefined, both checks collapsed, and `checks.length === 0`
 * returned null — on screen, identical to "this placement is fine". Same
 * defect as #350, missed by `reads:check` because the guard is not the
 * `if (!data) return null` shape the gate scans for.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { PlacementFitCard } from '@/features/plants/PlacementFitCard';
import type { PlantSpace } from '@/services/plantService';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

/** A room the cat can get into, with light good enough not to trip the light check. */
const petAccessibleSpace: PlantSpace = {
  id: 's1',
  householdId: 'h1',
  name: 'Sun room',
  environment: 'inside',
  rainExposure: 'sheltered',
  lightLevel: 'bright',
  petAccess: true,
  defaultCaregiverId: null,
  rotation: null,
};

function renderCard(species: string | null) {
  useAuthStore.setState({ accessToken: 'access-1' });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <PlacementFitCard space={petAccessibleSpace} species={species} perenualSpeciesId={42} />
    </QueryClientProvider>
  );
}

/** A species deliberately absent from `careGuidance.ts`, so the read is the only source. */
const UNCURATED = 'Calathea orbifolia';

function guideBody(poisonousToPets: boolean | null) {
  return {
    result: {
      commonName: 'Calathea',
      scientificName: UNCURATED,
      family: null,
      cycle: null,
      hardinessZone: null,
      indoor: true,
      poisonousToPets,
      sunlight: ['part shade'],
      sections: [],
    },
  };
}

describe('PlacementFitCard', () => {
  it('warns when a toxic species sits in a pet-accessible room', async () => {
    server.use(http.get(`${API}/species/42/guide`, () => HttpResponse.json(guideBody(true))));
    renderCard(UNCURATED);

    expect(await screen.findByText(/accessible to pets/)).toBeInTheDocument();
  });

  // The defect. Without the fix the card renders nothing at all here, which is
  // exactly what a household sees when the placement is genuinely fine.
  it('says the placement was not checked when the species read fails', async () => {
    server.use(
      http.get(`${API}/species/42/guide`, () =>
        HttpResponse.json({ message: 'upstream down' }, { status: 502 })
      )
    );
    renderCard(UNCURATED);

    expect(await screen.findByText(/has not been checked/)).toBeInTheDocument();
  });

  it('does not let a failed read look like an all-clear', async () => {
    server.use(
      http.get(`${API}/species/42/guide`, () =>
        HttpResponse.json({ message: 'upstream down' }, { status: 502 })
      )
    );
    const { container } = renderCard(UNCURATED);

    await waitFor(() => expect(container).not.toBeEmptyDOMElement());
    expect(screen.getByText(/Placement check/)).toBeInTheDocument();
  });

  // Characterization: these must hold both before and after the fix.
  it('stays silent when the read succeeds and nothing is wrong with the spot', async () => {
    server.use(http.get(`${API}/species/42/guide`, () => HttpResponse.json(guideBody(false))));
    const { container } = renderCard(UNCURATED);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('stays silent while the read is still in flight', () => {
    server.use(http.get(`${API}/species/42/guide`, () => new Promise(() => {})));
    const { container } = renderCard(UNCURATED);

    expect(container).toBeEmptyDOMElement();
  });

  it('does not claim anything is unchecked when the curated table answers both checks', async () => {
    server.use(
      http.get(`${API}/species/42/guide`, () =>
        HttpResponse.json({ message: 'upstream down' }, { status: 502 })
      )
    );
    // Monstera deliciosa is curated (medium light, toxic to pets), so the
    // failed read costs nothing: the pet warning still stands on its own.
    renderCard('Monstera deliciosa');

    expect(await screen.findByText(/accessible to pets/)).toBeInTheDocument();
    expect(screen.queryByText(/has not been checked/)).not.toBeInTheDocument();
  });
});
