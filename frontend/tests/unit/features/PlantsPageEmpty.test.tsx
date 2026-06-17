import { describe, expect, it, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PlantsPage } from '@/features/plants/PlantsPage';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

function renderPlants() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/plants']}>
        <Routes>
          <Route path="/plants" element={<PlantsPage />} />
          <Route path="/plants/new" element={<div>Add Plant Page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('PlantsPage empty state (first-plant activation)', () => {
  beforeEach(() => {
    useAuthStore.setState({ accessToken: 'access-1', user: { householdId: 'hh-1' } as never });
  });

  it('shows a single warm primary CTA to add the first plant, linking to /plants/new', async () => {
    server.use(http.get(`${API}/plants`, () => HttpResponse.json([])));
    renderPlants();

    // Warm, action-led heading instead of the old "No plants yet".
    expect(await screen.findByText(/let's add your first plant/i)).toBeInTheDocument();

    // The empty-state CTA points the user straight at the add-plant flow.
    const cta = await screen.findByRole('link', { name: /add your first plant/i });
    expect(cta).toHaveAttribute('href', '/plants/new');
  });

  it('reassures the user that it is quick', async () => {
    server.use(http.get(`${API}/plants`, () => HttpResponse.json([])));
    renderPlants();
    expect(await screen.findByText(/less than a minute/i)).toBeInTheDocument();
  });
});
