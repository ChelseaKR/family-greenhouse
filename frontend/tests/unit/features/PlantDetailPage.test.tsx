import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PlantDetailPage } from '@/features/plants/PlantDetailPage';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

function renderDetail(plantId: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/plants/${plantId}`]}>
        <Routes>
          <Route path="/plants/:plantId" element={<PlantDetailPage />} />
          <Route path="/plants" element={<div>Plants Index</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('PlantDetailPage', () => {
  it('renders the plant with empty task list', async () => {
    useAuthStore.setState({ accessToken: 'access-1' });
    server.use(
      http.get(`${API}/plants/p1`, () =>
        HttpResponse.json({
          id: 'p1',
          householdId: 'hh',
          name: 'Pothos',
          species: 'Epipremnum aureum',
          location: 'Living Room',
          imageUrl: null,
          notes: null,
          createdAt: '2026-04-25T00:00:00.000Z',
          createdBy: 'u1',
          updatedAt: '2026-04-25T00:00:00.000Z',
          upcomingTasks: [],
          recentCompletions: [],
        })
      )
    );
    renderDetail('p1');
    expect(await screen.findByRole('heading', { name: 'Pothos' })).toBeInTheDocument();
    // Regression: previously the page crashed when upcomingTasks was undefined.
    expect(await screen.findByText('No tasks')).toBeInTheDocument();
  });

  it('renders an upcoming task', async () => {
    useAuthStore.setState({ accessToken: 'access-1' });
    server.use(
      http.get(`${API}/plants/p1`, () =>
        HttpResponse.json({
          id: 'p1',
          householdId: 'hh',
          name: 'Pothos',
          species: null,
          location: null,
          imageUrl: null,
          notes: null,
          createdAt: '',
          createdBy: '',
          updatedAt: '',
          upcomingTasks: [
            {
              id: 't1',
              plantId: 'p1',
              plantName: 'Pothos',
              type: 'water',
              customType: null,
              frequency: 7,
              lastCompleted: null,
              nextDue: '2099-01-01T00:00:00.000Z',
              assignedTo: null,
              assignedToName: null,
              notes: null,
              createdBy: '',
              createdAt: '',
            },
          ],
          recentCompletions: [],
        })
      )
    );
    renderDetail('p1');
    expect(await screen.findAllByText(/water/i)).not.toHaveLength(0);
  });

  it('renders an error alert when the request fails', async () => {
    useAuthStore.setState({ accessToken: 'access-1' });
    server.use(
      http.get(`${API}/plants/p1`, () =>
        HttpResponse.json({ message: 'Not found' }, { status: 404 })
      )
    );
    renderDetail('p1');
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});
