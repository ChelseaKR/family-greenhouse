import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CareReportCard } from '@/features/plants/CareReportCard';
import { PlantDetailPage } from '@/features/plants/PlantDetailPage';
import { RECENT_COMPLETIONS_LIMIT, type PlantWithTasks } from '@/services/plantService';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const ahead = (days: number) => new Date(Date.now() + days * DAY).toISOString();

function task(id: string, type: string, lastCompleted: string | null) {
  return {
    id,
    plantId: 'p1',
    plantName: 'Fern',
    type,
    customType: type === 'custom' ? 'Mist' : undefined,
    frequency: type === 'custom' ? 1 : 30,
    lastCompleted,
    nextDue: ahead(5),
    assignedTo: null,
    assignedToName: null,
    notes: null,
    createdBy: 'u1',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

/**
 * The plant payload's `recentCompletions` holds only the newest
 * RECENT_COMPLETIONS_LIMIT rows across ALL of the plant's tasks. A daily
 * misting fills it in under two weeks, and the page used to report the
 * fertilize and the watering that fell out of it as "never" done.
 */
function plantWithFullWindow(): PlantWithTasks {
  const mist = task('t-mist', 'custom', ago(0));
  const water = task('t-water', 'water', ago(12));
  const feed = task('t-feed', 'fertilize', ago(34));
  return {
    id: 'p1',
    householdId: 'hh',
    name: 'Fern',
    species: null,
    location: null,
    imageUrl: null,
    notes: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'u1',
    updatedAt: '2026-01-01T00:00:00.000Z',
    upcomingTasks: [mist, water, feed],
    recentCompletions: Array.from({ length: RECENT_COMPLETIONS_LIMIT }, (_, i) => ({
      id: `c${i}`,
      taskId: 't-mist',
      taskType: 'custom',
      completedBy: 'u1',
      completedByName: 'Sam',
      completedAt: ago(i),
    })),
  } as unknown as PlantWithTasks;
}

describe('care report: last care outside the recent window', () => {
  it('shows the true last date, and "none in last N" rather than "0 done · never"', () => {
    render(<CareReportCard plant={plantWithFullWindow()} />);

    const rows = screen.getAllByRole('listitem');
    const feed = rows.find((row) => within(row).queryByText('fertilize'))!;
    expect(within(feed).getByText(`none in last ${RECENT_COMPLETIONS_LIMIT}`)).toBeInTheDocument();
    expect(within(feed).getByText('last 1mo ago')).toBeInTheDocument();
    expect(within(feed).queryByText(/never/)).not.toBeInTheDocument();

    const water = rows.find((row) => within(row).queryByText('water'))!;
    expect(within(water).getByText('last 1w ago')).toBeInTheDocument();
  });

  it('still says "never" for a task that has truly never been done', () => {
    const plant = plantWithFullWindow();
    plant.upcomingTasks = [task('t-repot', 'repot', null) as never];
    plant.recentCompletions = [];
    render(<CareReportCard plant={plant} />);

    const repot = screen.getAllByRole('listitem')[0];
    expect(within(repot).getByText('0 done')).toBeInTheDocument();
    expect(within(repot).getByText('last never')).toBeInTheDocument();
    expect(screen.getByText('Never')).toBeInTheDocument();
  });
});

describe('plant page: last watering outside the recent window', () => {
  function renderDetail(plant: PlantWithTasks) {
    useAuthStore.setState({ accessToken: 'access-1' });
    server.use(http.get(`${API}/plants/p1`, () => HttpResponse.json(plant as never)));
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

  it('reads the water task’s own last date instead of saying no watering was logged', async () => {
    renderDetail(plantWithFullWindow());

    const line = await screen.findByTestId('last-watered');
    expect(line).toHaveTextContent(/^Last watered /);
    expect(line).not.toHaveTextContent('No watering has been logged');
  });

  it('says no watering was logged only when the water task was never done', async () => {
    const plant = plantWithFullWindow();
    plant.upcomingTasks = plant.upcomingTasks.map((t) =>
      t.type === 'water' ? { ...t, lastCompleted: null } : t
    );
    renderDetail(plant);

    expect(await screen.findByTestId('last-watered')).toHaveTextContent(
      'No watering has been logged for this plant yet.'
    );
  });
});
