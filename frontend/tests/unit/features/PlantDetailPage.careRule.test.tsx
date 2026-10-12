import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PlantDetailPage } from '@/features/plants/PlantDetailPage';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';
import { UNDO_WINDOW_MS, resetDeferredCareQueueForTests } from '@/features/plants/deferredCare';

// Done waits out the shared 5-second Undo window (#919). Step the clock
// through it: a waitFor with its own 5-second timeout raced the window and
// failed under load.
async function throughTheWindow(completions: string[]) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS - 200);
  });
  expect(completions).toEqual([]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
}

const API = 'http://localhost:4000';

const waterTask = {
  id: 't1',
  plantId: 'p1',
  plantName: 'Calathea',
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
};

function plantResponse(careRule: string | null) {
  return {
    id: 'p1',
    householdId: 'hh',
    name: 'Calathea',
    species: null,
    location: null,
    imageUrl: null,
    notes: null,
    careRule,
    createdAt: '2026-04-25T00:00:00.000Z',
    createdBy: 'u1',
    updatedAt: '2026-04-25T00:00:00.000Z',
    upcomingTasks: [waterTask],
    recentCompletions: [],
  };
}

function renderDetail() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/plants/p1']}>
        <Routes>
          <Route path="/plants/:plantId" element={<PlantDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function serve(careRule: string | null) {
  const completions: string[] = [];
  useAuthStore.setState({ accessToken: 'access-1' });
  server.use(
    http.get(`${API}/plants/p1`, () => HttpResponse.json(plantResponse(careRule))),
    http.get(`${API}/spaces`, () => HttpResponse.json([])),
    http.post(`${API}/tasks/:id/complete`, ({ params }) => {
      completions.push(String(params.id));
      return HttpResponse.json({ ...waterTask, lastCompleted: new Date().toISOString() });
    })
  );
  return completions;
}

describe('PlantDetailPage house rule', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    resetDeferredCareQueueForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the rule on the page and again before a task is marked done', async () => {
    const completions = serve('Bottom-water only');
    renderDetail();

    await screen.findByRole('heading', { name: 'Calathea' });
    expect(screen.getByText('House rule')).toBeInTheDocument();
    expect(screen.getByText('Bottom-water only')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Bottom-water only')).toBeInTheDocument();
    expect(completions).toEqual([]);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark done' }));

    await throughTheWindow(completions);
    expect(completions).toEqual(['t1']);
  });

  it('renders no rule row and no dialog when the plant has none', async () => {
    const completions = serve(null);
    renderDetail();

    await screen.findByRole('heading', { name: 'Calathea' });
    expect(screen.queryByText('House rule')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await throughTheWindow(completions);
    expect(completions).toEqual(['t1']);
  });
});
