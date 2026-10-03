import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse, delay } from 'msw';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PlantsPage } from '@/features/plants/PlantsPage';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

/**
 * The phone layout ("Today first"): the website under 640px and the iOS app.
 * Every test here runs with the phone media query matching.
 */
const API = 'http://localhost:4000';
const ME = 'u-me';

function plant(id: string, name: string, spaceId: string | null = null) {
  return {
    id,
    householdId: 'hh-1',
    name,
    species: null,
    location: null,
    spaceId,
    imageUrl: null,
    notes: null,
    tags: id === 'p3' ? ['herbs'] : [],
    createdAt: '',
    createdBy: '',
    updatedAt: '',
  };
}

function dueIn(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(23, 0, 0, 0);
  return d.toISOString();
}

function task(id: string, plantId: string, days: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    plantId,
    plantName: plantId,
    type: 'water',
    frequency: 7,
    lastCompleted: null,
    nextDue: dueIn(days),
    assignedTo: null,
    assignedToName: null,
    notes: null,
    createdBy: 'x',
    createdAt: '',
    ...extra,
  };
}

const PLANTS = [
  plant('p1', 'Peace Lily', 's-bed'),
  plant('p2', 'Monstera', 's-living'),
  plant('p3', 'Basil', 's-kitchen'),
  plant('p4', 'Snake Plant', 's-bed'),
  plant('p5', 'Cactus'),
];
const SPACES = [
  { id: 's-living', name: 'Living Room', environment: 'inside' },
  { id: 's-kitchen', name: 'Kitchen', environment: 'inside' },
  { id: 's-bed', name: 'Bedroom', environment: 'inside' },
];
const TASKS = [
  task('t1', 'p1', -1), // overdue, up for grabs
  task('t2', 'p2', 0, {
    assignedTo: 'u-dana',
    assignedToName: 'Dana',
    effectiveAssignee: 'u-theo',
    effectiveAssigneeName: 'Theo',
    coveringFor: 'Dana',
  }),
  task('t3', 'p3', 0, { assignedTo: ME, assignedToName: 'Me' }),
  task('t4', 'p4', 3, { assignedTo: 'u-theo', assignedToName: 'Theo' }),
  // p5 has no task at all.
];

function renderPlants() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/plants']}>
        <Routes>
          <Route path="/plants" element={<PlantsPage />} />
          <Route path="/plants/new" element={<div>Add Plant Page</div>} />
          <Route path="/plants/import" element={<div>Import Page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const realMatchMedia = window.matchMedia;
beforeEach(() => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes('max-width: 639px'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    onchange: null,
    dispatchEvent: vi.fn(),
  })) as never;
  useAuthStore.setState({
    accessToken: 'access-1',
    user: { id: ME, householdId: 'hh-1' } as never,
  });
  server.use(
    http.get(`${API}/plants`, () => HttpResponse.json(PLANTS)),
    http.get(`${API}/spaces`, () => HttpResponse.json(SPACES)),
    http.get(`${API}/tasks`, () => HttpResponse.json(TASKS))
  );
});
afterEach(() => {
  window.matchMedia = realMatchMedia;
});

const section = (name: string) =>
  screen.getByRole('heading', { level: 2, name }).closest('section') as HTMLElement;

describe('Plants on a phone: today first', () => {
  it('leads with what needs care, overdue first, and says who has it', async () => {
    renderPlants();
    await screen.findByRole('heading', { level: 2, name: 'Needs care' });

    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(['Needs care', 'Coming up', 'No care scheduled']);

    const rows = within(section('Needs care')).getAllByRole('link');
    expect(rows.map((r) => r.getAttribute('aria-label'))).toEqual([
      'Peace Lily, Water · 1 day overdue, Bedroom, Up for grabs',
      'Basil, Water today, Kitchen, You',
      'Monstera, Water today, Living Room, Theo, covering for Dana',
    ]);
    // The covering member is named, not the assignee who is away.
    expect(within(rows[2]).getByText('Theo, covering')).toBeInTheDocument();
    expect(within(rows[2]).queryByText('Dana')).not.toBeInTheDocument();
  });

  it('shows a first name in the chip and the full name to a screen reader', async () => {
    server.use(
      http.get(`${API}/tasks`, () =>
        HttpResponse.json([
          task('t1', 'p1', 0, { assignedTo: 'u-t', assignedToName: 'Theo Nakamura' }),
        ])
      )
    );
    renderPlants();
    const row = await screen.findByRole('link', {
      name: /Peace Lily, Water today, Bedroom, Theo Nakamura/,
    });
    expect(within(row).getByText('Theo')).toBeInTheDocument();
  });

  it('puts a plant with no care task in its own group, never under "All good"', async () => {
    renderPlants();
    const none = await screen.findByRole('heading', { level: 2, name: 'No care scheduled' });
    expect(
      within(none.closest('section')!).getByRole('link', { name: /Cactus/ })
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'All good' })).not.toBeInTheDocument();
  });

  it('a FAILED tasks read shows the plants with no status, and never "All good"', async () => {
    server.use(http.get(`${API}/tasks`, () => new HttpResponse(null, { status: 500 })));
    renderPlants();

    expect(await screen.findByText(/care status couldn’t be loaded/i)).toBeInTheDocument();
    for (const name of ['Needs care', 'Coming up', 'All good', 'No care scheduled']) {
      expect(screen.queryByRole('heading', { name })).not.toBeInTheDocument();
    }
    const all = section('All plants');
    const links = within(all).getAllByRole('link');
    expect(links).toHaveLength(5);
    // No row claims a status it does not have.
    for (const link of links) {
      expect(link.getAttribute('aria-label')).not.toMatch(/water|overdue|today|no care/i);
    }
  });

  it('a tasks read still in flight claims no status either', async () => {
    server.use(
      http.get(`${API}/tasks`, async () => {
        await delay('infinite');
        return HttpResponse.json([]);
      })
    );
    renderPlants();
    expect(await screen.findByText(/loading care status/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'All plants' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'All good' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'No care scheduled' })).not.toBeInTheDocument();
  });

  it('collapses the old toolbar: no view switcher, no chips, no Move/Apply buttons', async () => {
    renderPlants();
    await screen.findByRole('heading', { level: 2, name: 'Needs care' });
    expect(screen.queryByRole('group', { name: 'View mode' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('group', { name: /filter plants by space/i })
    ).not.toBeInTheDocument();
    // Move and Apply template now live only inside the closed "…" menu.
    for (const name of [/apply template/i, /^move plants$/i]) {
      const inMenu = screen.getByRole('button', { name }).closest('details');
      expect(inMenu).not.toBeNull();
      expect(inMenu).not.toHaveAttribute('open');
      expect(inMenu!.querySelector('summary')).toHaveAccessibleName('More plant actions');
    }
    // One Add, and the two menus.
    expect(screen.getAllByRole('link', { name: /add plant/i })).toHaveLength(1);
    expect(screen.getByLabelText('Filter plants')).toBeInTheDocument();
    expect(screen.getByLabelText('More plant actions')).toBeInTheDocument();
  });

  it('"Only mine" filters to my work, shows a removable token, and announces the count', async () => {
    const user = userEvent.setup();
    renderPlants();
    await screen.findByRole('heading', { level: 2, name: 'Needs care' });

    await user.click(screen.getByLabelText('Filter plants'));
    await user.click(screen.getByRole('button', { name: 'Only mine' }));

    expect(screen.getAllByRole('link', { name: /water/i }).map((l) => l.textContent)).toEqual([
      expect.stringContaining('Basil'),
    ]);
    expect(await screen.findByText('1 plant in this view.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove filter: Only mine' }));
    expect(screen.getByRole('link', { name: /Peace Lily/ })).toBeInTheDocument();
  });

  it('"Up for grabs" shows only unclaimed work', async () => {
    const user = userEvent.setup();
    renderPlants();
    await screen.findByRole('heading', { level: 2, name: 'Needs care' });
    await user.click(screen.getByLabelText('Filter plants'));
    await user.click(
      within(screen.getByRole('group', { name: 'Show' })).getByRole('button', {
        name: 'Up for grabs',
      })
    );
    const links = screen.getAllByRole('link', { name: /Bedroom|Kitchen|Living/ });
    expect(links.map((l) => l.getAttribute('aria-label'))).toEqual([
      'Peace Lily, Water · 1 day overdue, Bedroom, Up for grabs',
    ]);
  });

  it('groups by space from the filter menu, urgent first inside each space', async () => {
    const user = userEvent.setup();
    renderPlants();
    await screen.findByRole('heading', { level: 2, name: 'Needs care' });
    await user.click(screen.getByLabelText('Filter plants'));
    await user.click(screen.getByRole('button', { name: 'Space' }));
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(['Living Room', 'Kitchen', 'Bedroom', 'Unplaced']);
    expect(
      within(section('Bedroom'))
        .getAllByRole('link')
        .map((l) => l.textContent)
    ).toEqual([expect.stringContaining('Peace Lily'), expect.stringContaining('Snake Plant')]);
  });

  it('filters by tag, a filter no screen offered before', async () => {
    const user = userEvent.setup();
    renderPlants();
    await screen.findByRole('heading', { level: 2, name: 'Needs care' });
    await user.click(screen.getByLabelText('Filter plants'));
    await user.click(screen.getByRole('button', { name: 'herbs' }));
    expect(screen.getAllByRole('link', { name: /Kitchen|Bedroom|Living|Unplaced/ })).toHaveLength(
      1
    );
    expect(screen.getByRole('button', { name: 'Remove filter: herbs' })).toBeInTheDocument();
  });

  it('opens past plants from the More menu, with a token back', async () => {
    const user = userEvent.setup();
    server.use(
      http.get(`${API}/plants`, ({ request }) =>
        new URL(request.url).searchParams.get('status') === 'past' ||
        new URL(request.url).search.includes('past')
          ? HttpResponse.json([{ ...plant('x', 'Old Fern'), status: 'died' }])
          : HttpResponse.json(PLANTS)
      )
    );
    renderPlants();
    await screen.findByRole('heading', { level: 2, name: 'Needs care' });
    await user.click(screen.getByLabelText('More plant actions'));
    await user.click(screen.getByRole('button', { name: 'Past plants' }));
    expect(await screen.findByRole('link', { name: /Old Fern/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove filter: Past plants' }));
    expect(await screen.findByRole('link', { name: /Peace Lily/ })).toBeInTheDocument();
  });

  it('an empty household gets one call to action and no toolbar', async () => {
    server.use(http.get(`${API}/plants`, () => HttpResponse.json([])));
    renderPlants();
    expect(await screen.findByText(/let's add your first plant/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /add your first plant/i })).toHaveAttribute(
      'href',
      '/plants/new'
    );
    expect(screen.getByRole('link', { name: /import a list of plants/i })).toHaveAttribute(
      'href',
      '/plants/import'
    );
    expect(screen.queryByLabelText('Search plants')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Filter plants')).not.toBeInTheDocument();
  });

  it('search still announces how many plants matched', async () => {
    const user = userEvent.setup();
    renderPlants();
    await screen.findByRole('heading', { level: 2, name: 'Needs care' });
    await user.type(screen.getByLabelText('Search plants'), 'lily');
    const live = await screen.findByText(/1 plant matches/);
    expect(live.closest('[aria-live="polite"]')).not.toBeNull();
  });
});
