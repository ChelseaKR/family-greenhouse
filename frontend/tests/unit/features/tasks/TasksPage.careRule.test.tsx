import { describe, expect, it } from 'vitest';
import { delay, http, HttpResponse } from 'msw';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TasksPage } from '@/features/tasks/TasksPage';
import { useAuthStore, User } from '@/store/authStore';
import { server } from '../../../msw/server';

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
  createdBy: 'u1',
  createdAt: '',
};

function plant(careRule: string | null) {
  return {
    id: 'p1',
    householdId: 'hh-1',
    name: 'Calathea',
    species: null,
    location: null,
    imageUrl: null,
    notes: null,
    careRule,
    createdAt: '',
    createdBy: 'u1',
    updatedAt: '',
  };
}

function renderTasksPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/tasks']}>
        <TasksPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

/** Serves the page with one water task for a plant carrying `careRule`. */
function serve(careRule: string | null) {
  const completions: string[] = [];
  server.use(
    // Tasks answer a beat after plants so the row renders with the plant
    // already known — the gate reads the plant at click time.
    http.get(`${API}/tasks`, async () => {
      await delay(25);
      return HttpResponse.json([waterTask]);
    }),
    http.get(`${API}/plants`, () => HttpResponse.json([plant(careRule)])),
    http.get(`${API}/spaces`, () => HttpResponse.json([])),
    http.get(`${API}/households/hh-1/climate`, () =>
      HttpResponse.json({ configured: false, weather: null, tips: [] })
    ),
    http.post(`${API}/tasks/:id/complete`, ({ params }) => {
      completions.push(String(params.id));
      return HttpResponse.json({ ...waterTask, lastCompleted: new Date().toISOString() });
    })
  );
  return completions;
}

describe('TasksPage house rule at completion', () => {
  function signIn() {
    useAuthStore.setState({
      accessToken: 'access-1',
      user: { id: 'u1', email: 'me@example.com', name: 'Me', householdId: 'hh-1' } as User,
    });
  }

  it("shows the plant's house rule before completing, and completes only on confirm", async () => {
    signIn();
    const completions = serve('Bottom-water only');
    renderTasksPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Done' }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Bottom-water only')).toBeInTheDocument();
    expect(screen.getByText('Before you mark Calathea done')).toBeInTheDocument();
    expect(completions).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Mark done' }));

    await waitFor(() => expect(completions).toEqual(['t1']));
  });

  it('completes straight away, with nothing shown, when the plant has no rule', async () => {
    signIn();
    const completions = serve(null);
    renderTasksPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Done' }));

    await waitFor(() => expect(completions).toEqual(['t1']));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText(/House rule/)).not.toBeInTheDocument();
  });
});
