import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { http, HttpResponse } from 'msw';
import { AddPlantPage } from '@/features/plants/AddPlantPage';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

/**
 * The Add Plant page at the free plant cap (ADR 0040): the upgrade prompt is
 * shown ABOVE the form, before anything is typed, rather than as a refusal
 * after the form is filled in.
 */

vi.mock('@/services/taskService', () => ({
  taskService: {
    listTemplates: vi.fn(async () => []),
    applyTemplate: vi.fn(),
    createTask: vi.fn(),
  },
  suggestTaskTemplate: vi.fn(() => null),
}));

const API = 'http://localhost:4000';

function stub(usageDetail: Record<string, number | null>) {
  let reads = 0;
  server.use(
    http.get(`${API}/me/households`, () =>
      HttpResponse.json([{ householdId: 'hh-1', name: 'Home', role: 'admin', joinedAt: '' }])
    ),
    http.get(`${API}/billing/plans`, () =>
      HttpResponse.json({
        paymentsAvailable: true,
        commercialHold: { active: false, effectiveDate: '2026-09-01' },
        plans: [
          { id: 'seedling', name: 'Seedling', description: '', maxPlants: 8, maxMembers: 2 },
          {
            id: 'garden',
            name: 'Garden',
            description: '',
            maxPlants: 200,
            maxMembers: null,
            monthlyPrice: 4.99,
          },
        ],
      })
    ),
    http.get(`${API}/households/hh-1`, () =>
      HttpResponse.json({
        id: 'hh-1',
        name: 'Home',
        createdAt: '',
        createdBy: 'u-me',
        members: [{ userId: 'u-me', name: 'Sam', role: 'admin', joinedAt: '' }],
      })
    ),
    http.get(`${API}/billing/me`, () => {
      reads += 1;
      return HttpResponse.json({ planId: 'seedling', usageDetail });
    }),
    // Anything else the page reads (spaces, species) answers empty. Last:
    // the first matching handler wins.
    http.get(`${API}/*`, () => HttpResponse.json([]))
  );
  return { reads: () => reads };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/plants/new']}>
        <Routes>
          <Route path="/plants/new" element={<AddPlantPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('AddPlantPage at the plant cap', () => {
  beforeEach(() => {
    useAuthStore.setState({
      accessToken: 'access-1',
      user: {
        id: 'u-me',
        email: 'me@example.com',
        name: 'Sam',
        householdId: 'hh-1',
        householdRole: 'admin',
      },
      activeHouseholdId: 'hh-1',
    });
  });

  it('shows the upgrade prompt, with the price, before the form', async () => {
    stub({ plantCount: 8, maxPlants: 8, memberCount: 1, maxMembers: 2 });
    renderPage();
    const prompt = await screen.findByTestId('plan-cap-prompt-plants');
    expect(prompt).toHaveTextContent('Your plan holds 8 active plants, and this household has 8.');
    expect(await screen.findByTestId('locked-included')).toHaveTextContent('$4.99 a month');
    // The prompt comes before the form in the page, so it is read first.
    const nameField = screen.getByLabelText(/name/i, { selector: 'input' });
    expect(
      prompt.compareDocumentPosition(nameField) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('negative control: no prompt below the cap', async () => {
    const reads = stub({ plantCount: 5, maxPlants: 8, memberCount: 1, maxMembers: 2 });
    renderPage();
    await waitFor(() => expect(reads.reads()).toBeGreaterThan(0));
    expect(screen.queryByTestId('plan-cap-prompt-plants')).not.toBeInTheDocument();
  });
});
