import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PlantDetailPage } from '@/features/plants/PlantDetailPage';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

function renderDetail(plantId: string, state?: unknown) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[{ pathname: `/plants/${plantId}`, state }]}>
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

  it('does not mark a task due today at a non-midnight time as overdue', async () => {
    useAuthStore.setState({ accessToken: 'access-1' });
    // Due earlier today (not midnight) — a raw instant comparison would
    // call this "overdue" once the day has moved past that hour, but it's
    // still within today's calendar day.
    const dueEarlierToday = new Date();
    dueEarlierToday.setHours(0, 1, 0, 0);
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
              nextDue: dueEarlierToday.toISOString(),
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
    const dueText = await screen.findByText(/Due:/);
    expect(dueText.className).not.toMatch(/text-accent-700/);
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

  it('honestly explains how to recover when creation saved without its photo', async () => {
    useAuthStore.setState({ accessToken: 'access-1' });
    server.use(
      http.get(`${API}/plants/p1`, () =>
        HttpResponse.json({
          id: 'p1',
          householdId: 'hh',
          name: 'Saved Fern',
          species: null,
          location: null,
          imageUrl: null,
          notes: null,
          createdAt: '',
          createdBy: '',
          updatedAt: '',
          upcomingTasks: [],
          recentCompletions: [],
        })
      )
    );

    renderDetail('p1', { photoUploadFailed: true });

    // `variant="info"` announces politely (role="status"): the plant did
    // save, so this must not interrupt whatever is being read.
    const recovery = await screen.findByRole('status');
    expect(recovery).toHaveTextContent('Plant saved; photo not uploaded');
    expect(recovery).toHaveTextContent('Choose the photo again below to retry');
    expect(screen.getByLabelText(/upload photo/i)).toBeEnabled();
  });

  describe('streak chip', () => {
    const waterTask = {
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
    };

    function completion(taskId: string, daysAgo: number) {
      const d = new Date();
      d.setDate(d.getDate() - daysAgo);
      return {
        id: `c-${taskId}-${daysAgo}`,
        taskId,
        taskType: 'water',
        completedBy: 'u1',
        completedByName: 'A',
        completedAt: d.toISOString(),
        notes: null,
      };
    }

    function servePlant(recentCompletions: unknown[]) {
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
            upcomingTasks: [waterTask],
            recentCompletions,
          })
        )
      );
    }

    it('states a plain count when the completion window is not full', async () => {
      useAuthStore.setState({ accessToken: 'access-1' });
      servePlant([completion('t1', 0), completion('t1', 7), completion('t1', 14)]);
      renderDetail('p1');
      expect(await screen.findByText(/3-cycle watering streak/)).toBeInTheDocument();
    });

    it('marks the count a floor when the window came back full', async () => {
      // Regression for the defect #328 fixed on CareReportCard but not here:
      // `recentCompletions` is capped at RECENT_COMPLETIONS_LIMIT rows across
      // ALL of the plant's tasks, so a full window means older care exists
      // that the page cannot see. Rendering "10-cycle watering streak" for a
      // plant watered forty times states a ceiling as a measurement.
      useAuthStore.setState({ accessToken: 'access-1' });
      servePlant(Array.from({ length: 10 }, (_, i) => completion('t1', i * 7)));
      renderDetail('p1');
      expect(
        await screen.findByText('🌱 10+ cycle watering streak (within the last 10 logged)')
      ).toBeInTheDocument();
      expect(screen.queryByText(/🌱 10-cycle watering streak$/)).not.toBeInTheDocument();
    });

    it('marks the count a floor when other tasks fill the shared window', async () => {
      // Only two of the ten rows belong to the water task; the other eight
      // are a different task's. The window is still saturated, so the water
      // streak is still a floor.
      useAuthStore.setState({ accessToken: 'access-1' });
      servePlant([
        completion('t1', 0),
        completion('t1', 7),
        ...Array.from({ length: 8 }, (_, i) => completion('t2', i * 7)),
      ]);
      renderDetail('p1');
      expect(
        await screen.findByText('🌱 2+ cycle watering streak (within the last 10 logged)')
      ).toBeInTheDocument();
    });
  });

  describe('pet toxicity is not carried by the care-guide fetch (#350)', () => {
    function serveEnrichedPlant() {
      server.use(
        http.get(`${API}/plants/p1`, () =>
          HttpResponse.json({
            id: 'p1',
            householdId: 'hh',
            name: 'Monstera',
            species: 'Monstera deliciosa',
            perenualSpeciesId: 42,
            location: null,
            imageUrl: null,
            notes: null,
            createdAt: '',
            createdBy: '',
            updatedAt: '',
            upcomingTasks: [],
            recentCompletions: [],
          })
        )
      );
    }

    /** `/species/:id` — the toxicity lookup, on its own read. */
    function serveToxicity(poisonousToPets: boolean | null) {
      server.use(
        http.get(`${API}/species/42`, () =>
          HttpResponse.json({
            status: 'found',
            result: {
              id: 42,
              commonName: 'Monstera',
              scientificName: 'Monstera deliciosa',
              thumbnailUrl: null,
              family: null,
              cycle: null,
              watering: null,
              sunlight: [],
              hardinessZone: null,
              indoor: true,
              edible: false,
              poisonousToPets,
              defaultImageUrl: null,
            },
          })
        )
      );
    }

    it('still warns about a toxic species when the care-guide read fails', async () => {
      // The page used to show toxicity ONLY inside CareGuideCard, which
      // returned null on a failed fetch. A Perenual outage therefore removed
      // the warning with no trace — the same silence as "this species has no
      // guide" — for a plant already living in the household.
      useAuthStore.setState({ accessToken: 'access-1' });
      serveEnrichedPlant();
      serveToxicity(true);
      server.use(
        http.get(`${API}/species/42/guide`, () =>
          HttpResponse.json({ message: 'upstream down' }, { status: 502 })
        )
      );
      renderDetail('p1');

      expect(await screen.findByText('Toxic to pets')).toBeInTheDocument();
      expect(screen.getByText(/keep it out of reach/i)).toBeInTheDocument();
      // The add-plant reassurance must not follow a plant that is already here.
      expect(screen.queryByText(/You can still add it/i)).not.toBeInTheDocument();
    });

    it('says toxicity could not be checked when the toxicity read itself fails', async () => {
      useAuthStore.setState({ accessToken: 'access-1' });
      serveEnrichedPlant();
      server.use(
        http.get(`${API}/species/42`, () =>
          HttpResponse.json({ message: 'boom' }, { status: 500 })
        ),
        http.get(`${API}/species/42/guide`, () => HttpResponse.json({ result: null }))
      );
      renderDetail('p1');

      expect(await screen.findByText(/Couldn.?t check pet toxicity/i)).toBeInTheDocument();
    });
  });
});
