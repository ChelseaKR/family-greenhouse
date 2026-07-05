import { describe, expect, it, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EditPlantModal } from '@/features/plants/EditPlantModal';
import { Plant } from '@/services/plantService';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

function makePlant(overrides: Partial<Plant> = {}): Plant {
  return {
    id: 'p1',
    householdId: 'hh-1',
    name: 'Monstera',
    species: 'Monstera deliciosa',
    location: null,
    imageUrl: null,
    notes: null,
    perenualSpeciesId: 42,
    createdAt: '',
    createdBy: 'u1',
    updatedAt: '',
    ...overrides,
  };
}

function renderModal(plant: Plant) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <EditPlantModal plant={plant} isOpen onClose={() => {}} />
    </QueryClientProvider>
  );
}

describe('EditPlantModal', () => {
  beforeEach(() => {
    useAuthStore.setState({ accessToken: 'access-1' });
    // No species has a Perenual match by default in these tests — the
    // combobox's own debounced lookup is not what's under test here.
    server.use(
      http.get(`${API}/species/search`, () =>
        HttpResponse.json({ source: 'perenual', results: [] })
      )
    );
  });

  it('renders the species field as a combobox seeded with the plant value', () => {
    renderModal(makePlant());
    const input = screen.getByLabelText(/species/i) as HTMLInputElement;
    expect(input.value).toBe('Monstera deliciosa');
    // Regression guard: a plain <Input> has no `list` attribute — this must
    // be the SpeciesCombobox, not the old plain text input.
    expect(input.getAttribute('list')).toBeTruthy();
  });

  it('sends null for perenualSpeciesId once the species text no longer matches a known species', async () => {
    let body: Record<string, unknown> | undefined;
    server.use(
      http.put(`${API}/plants/p1`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(makePlant({ ...(body as Partial<Plant>) }));
      })
    );
    const user = userEvent.setup();
    renderModal(makePlant());

    const input = screen.getByLabelText(/species/i);
    await user.clear(input);
    await user.type(input, 'not a real species');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(body).toBeDefined());
    expect(body?.perenualSpeciesId).toBeNull();
  });

  it('still sends the original perenualSpeciesId when the species field is left untouched', async () => {
    let body: Record<string, unknown> | undefined;
    server.use(
      http.put(`${API}/plants/p1`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(makePlant({ ...(body as Partial<Plant>) }));
      })
    );
    const user = userEvent.setup();
    renderModal(makePlant({ perenualSpeciesId: 42 }));

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(body).toBeDefined());
    // Never omitted — omitting it would leave the backend's existing value
    // untouched, which reads as "unchanged" but is indistinguishable from
    // the stale-attachment bug in a request-body assertion, so we assert
    // the key is explicitly present with the right value.
    expect(body).toHaveProperty('perenualSpeciesId', 42);
  });

  it('updates perenualSpeciesId to a newly recognized species when the text is edited to match one', async () => {
    server.use(
      http.get(`${API}/species/search`, ({ request }) => {
        const q = new URL(request.url).searchParams.get('q');
        if (q?.toLowerCase().includes('nephrolepis')) {
          return HttpResponse.json({
            source: 'perenual',
            results: [
              {
                id: 7,
                commonName: 'Boston fern',
                scientificName: 'Nephrolepis exaltata',
                thumbnailUrl: null,
              },
            ],
          });
        }
        return HttpResponse.json({ source: 'perenual', results: [] });
      })
    );
    let body: Record<string, unknown> | undefined;
    server.use(
      http.put(`${API}/plants/p1`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(makePlant({ ...(body as Partial<Plant>) }));
      })
    );
    const user = userEvent.setup();
    renderModal(makePlant());

    const input = screen.getByLabelText(/species/i);
    await user.clear(input);
    await user.type(input, 'Nephrolepis exaltata');

    // Give the combobox's 300ms debounce + mocked fetch time to resolve and
    // re-check the match (Bug 3's catch-up effect).
    await waitFor(() => expect((input as HTMLInputElement).value).toBe('Nephrolepis exaltata'), {
      timeout: 2000,
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(body).toBeDefined());
    expect(body?.perenualSpeciesId).toBe(7);
  });
});
