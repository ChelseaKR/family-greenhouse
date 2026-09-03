import { describe, expect, it, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EditPlantModal } from '@/features/plants/EditPlantModal';
import { CARE_RULE_MAX_LENGTH, Plant } from '@/services/plantService';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

function makePlant(overrides: Partial<Plant> = {}): Plant {
  return {
    id: 'p1',
    householdId: 'hh-1',
    name: 'Calathea',
    species: null,
    location: null,
    imageUrl: null,
    notes: null,
    perenualSpeciesId: null,
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

function captureUpdate() {
  const captured: { body?: Record<string, unknown> } = {};
  server.use(
    http.put(`${API}/plants/p1`, async ({ request }) => {
      captured.body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json(makePlant(captured.body as Partial<Plant>));
    })
  );
  return captured;
}

describe('EditPlantModal house rule', () => {
  beforeEach(() => {
    useAuthStore.setState({ accessToken: 'access-1' });
    server.use(
      http.get(`${API}/species/search`, () =>
        HttpResponse.json({ source: 'perenual', results: [] })
      )
    );
  });

  it('seeds the field with the stored rule, caps it, and counts its characters', () => {
    renderModal(makePlant({ careRule: 'Bottom-water only' }));
    const input = screen.getByLabelText('House rule') as HTMLInputElement;
    expect(input.value).toBe('Bottom-water only');
    expect(input).toHaveAttribute('maxlength', String(CARE_RULE_MAX_LENGTH));
    expect(screen.getByText(/17 of 140 characters\./)).toBeInTheDocument();
  });

  it('updates the counter as the rule is typed and stops at the cap', async () => {
    const user = userEvent.setup();
    renderModal(makePlant());
    const input = screen.getByLabelText('House rule') as HTMLInputElement;
    expect(screen.getByText(/0 of 140 characters\./)).toBeInTheDocument();

    await user.type(input, 'Mist, never soak');
    expect(screen.getByText(/16 of 140 characters\./)).toBeInTheDocument();

    await user.clear(input);
    await user.type(input, 'x'.repeat(CARE_RULE_MAX_LENGTH + 5));
    expect(input.value).toHaveLength(CARE_RULE_MAX_LENGTH);
    expect(screen.getByText(/140 of 140 characters\./)).toBeInTheDocument();
  });

  it('sends the trimmed rule on save', async () => {
    const captured = captureUpdate();
    const user = userEvent.setup();
    renderModal(makePlant());

    await user.type(screen.getByLabelText('House rule'), '  Bottom-water only  ');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(captured.body).toBeDefined());
    expect(captured.body?.careRule).toBe('Bottom-water only');
  });

  it('sends null — not "" — when the rule is cleared, so the backend drops it', async () => {
    const captured = captureUpdate();
    const user = userEvent.setup();
    renderModal(makePlant({ careRule: 'Bottom-water only' }));

    await user.clear(screen.getByLabelText('House rule'));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(captured.body).toBeDefined());
    // Explicitly present as null: an omitted key would leave the old rule
    // in place, which is indistinguishable from "cleared" in the UI.
    expect(captured.body).toHaveProperty('careRule', null);
  });
});
