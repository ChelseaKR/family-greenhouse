/**
 * The print sheet is the only place a household can see which labels are live
 * and turn one off, so a FAILED read must never render as "you have no
 * labels" — the labels in the pots keep working either way (ADR 0010/0016).
 * The rest pins the plan gate and that a printed label carries a real QR code
 * for the tag's own URL rather than a placeholder.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { PlantTagsPage } from '@/features/tags/PlantTagsPage';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';
const TOKEN = 'a3f9'.repeat(16);

const monsteraTag = {
  id: 'tag-1',
  householdId: 'hh-1',
  plantId: 'p1',
  plantName: 'Monstera',
  plantSpecies: 'Monstera deliciosa',
  plantStatus: 'active',
  createdBy: 'u1',
  createdAt: '2026-09-01T00:00:00.000Z',
  status: 'active',
  revokedAt: null,
  token: TOKEN,
  url: `https://familygreenhouse.net/tag/${TOKEN}`,
};

const plants = [
  { id: 'p1', name: 'Monstera', species: null, imageUrl: null, notes: null, tags: [] },
  { id: 'p2', name: 'Pothos', species: null, imageUrl: null, notes: null, tags: [] },
];

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <PlantTagsPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function tagsResponse(overrides: Record<string, unknown> = {}) {
  return {
    tags: [monsteraTag],
    pinEnabled: false,
    allowance: { enabled: true, max: 50, used: 1 },
    planId: 'garden',
    ...overrides,
  };
}

describe('PlantTagsPage', () => {
  beforeEach(() => {
    useAuthStore.setState({
      accessToken: 'access-1',
      user: {
        id: 'u1',
        email: 'test@example.com',
        name: 'Test',
        householdId: 'hh-1',
        householdRole: 'admin',
      },
      activeHouseholdId: 'hh-1',
    });
    server.use(
      http.get(`${API}/me/households`, () =>
        HttpResponse.json([{ householdId: 'hh-1', name: 'Home', role: 'admin', joinedAt: '' }])
      ),
      http.get(`${API}/plants`, () => HttpResponse.json(plants))
    );
  });

  it('prints a real QR code for each label, encoding that tag’s own URL', async () => {
    server.use(
      http.get(`${API}/households/hh-1/plant-tags`, () => HttpResponse.json(tagsResponse()))
    );
    renderPage();

    const sheet = await screen.findByRole('region', { name: 'Printable labels' });
    const code = within(sheet).getByRole('img', {
      name: 'QR code linking to the care page for Monstera',
    });
    // A real encoded symbol, not a placeholder: the version-8 Q-level matrix
    // for this URL is 49 modules, plus two 4-module quiet zones.
    expect(code.getAttribute('viewBox')).toBe('0 0 57 57');
    expect(code.querySelector('path')?.getAttribute('d')?.length ?? 0).toBeGreaterThan(500);
    expect(within(sheet).getByText('Monstera')).toBeInTheDocument();
  });

  it('says the labels could not be loaded instead of implying there are none', async () => {
    server.use(
      http.get(`${API}/households/hh-1/plant-tags`, () => new HttpResponse(null, { status: 500 }))
    );
    renderPage();

    expect(await screen.findByText('We couldn’t load your plant tags')).toBeInTheDocument();
    expect(
      screen.getByText(/Any labels you have already printed are still working/)
    ).toBeInTheDocument();
    // Crucially NOT the empty state.
    expect(screen.queryByText(/No labels yet/)).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Printable labels' })).not.toBeInTheDocument();
  });

  it('shows the upgrade path instead of the sheet when the plan has no tags', async () => {
    server.use(
      http.get(`${API}/households/hh-1/plant-tags`, () =>
        HttpResponse.json(
          tagsResponse({
            tags: [],
            allowance: { enabled: false, max: 0, used: 0 },
            planId: 'seedling',
          })
        )
      )
    );
    renderPage();

    expect(await screen.findByText('Plant tags come with the Garden plan')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See the plans' })).toHaveAttribute('href', '/pricing');
    expect(screen.queryByRole('button', { name: /Print the sheet/ })).not.toBeInTheDocument();
  });

  it('offers a label for each untagged plant and issues one on click', async () => {
    const issued = vi.fn();
    server.use(
      http.get(`${API}/households/hh-1/plant-tags`, () => HttpResponse.json(tagsResponse())),
      http.post(`${API}/plants/p2/tag`, () => {
        issued();
        return HttpResponse.json({
          ...monsteraTag,
          id: 'tag-2',
          plantId: 'p2',
          plantName: 'Pothos',
        });
      })
    );
    renderPage();

    const addButton = await screen.findByRole('button', { name: 'Pothos' });
    await userEvent.click(addButton);
    await waitFor(() => expect(issued).toHaveBeenCalledTimes(1));
    // The already-tagged plant is not offered again.
    expect(screen.queryByRole('button', { name: 'Monstera' })).not.toBeInTheDocument();
  });

  it('stops offering new labels at the plan cap', async () => {
    server.use(
      http.get(`${API}/households/hh-1/plant-tags`, () =>
        HttpResponse.json(tagsResponse({ allowance: { enabled: true, max: 1, used: 1 } }))
      )
    );
    renderPage();

    expect(await screen.findByRole('button', { name: 'Pothos' })).toBeDisabled();
    expect(screen.getByText(/used every label your plan includes/)).toBeInTheDocument();
  });

  it('confirms before turning a label off, then revokes it', async () => {
    const revoked = vi.fn();
    server.use(
      http.get(`${API}/households/hh-1/plant-tags`, () => HttpResponse.json(tagsResponse())),
      http.delete(`${API}/plants/p1/tag`, () => {
        revoked();
        return new HttpResponse(null, { status: 204 });
      })
    );
    renderPage();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Turn off the label for Monstera' })
    );
    expect(await screen.findByText('Turn off this label?')).toBeInTheDocument();
    expect(revoked).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(revoked).toHaveBeenCalledTimes(1));
  });
});
