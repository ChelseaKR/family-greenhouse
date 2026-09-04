import { describe, expect, it, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PlantsPage } from '@/features/plants/PlantsPage';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

/**
 * #445 and #447. None of these are axe findings — `tablist` + `tab` satisfies
 * every `aria-required-*` rule, a missing `aria-expanded` on a plain button is
 * not a violation, and axe inspects a static snapshot so it cannot see a list
 * that changed with nothing announced. All three need hand-written assertions.
 */

function plant(id: string, name: string, species: string | null = null) {
  return {
    id,
    householdId: 'hh-1',
    name,
    species,
    location: null,
    imageUrl: null,
    notes: null,
    createdAt: '',
    createdBy: '',
    updatedAt: '',
  };
}

function renderPlants() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

const THREE_PLANTS = [
  plant('p1', 'Monstera', 'Monstera deliciosa'),
  plant('p2', 'Monkey mask', 'Monstera adansonii'),
  plant('p3', 'Fiddle leaf fig', 'Ficus lyrata'),
];

beforeEach(() => {
  useAuthStore.setState({ accessToken: 'access-1', user: { householdId: 'hh-1' } as never });
  server.use(
    http.get(`${API}/plants`, () => HttpResponse.json(THREE_PLANTS)),
    http.get(`${API}/spaces`, () => HttpResponse.json([]))
  );
});

describe('PlantsPage collection switch', () => {
  it('does not claim the tab pattern it has never implemented', async () => {
    renderPlants();
    await screen.findByRole('button', { name: 'Past plants' });

    // No arrow-key handler, no aria-controls, no tabpanel — so no role="tab".
    // NVDA/JAWS announce "tab, 1 of 2" and switch into tab-interaction mode,
    // then arrow keys do nothing and there is no panel to jump to.
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.queryAllByRole('tablist')).toHaveLength(0);
    expect(screen.queryAllByRole('tabpanel')).toHaveLength(0);
  });

  it('announces the two collections as toggle buttons whose pressed state is true', async () => {
    const user = userEvent.setup();
    renderPlants();

    const group = screen.getByRole('group', { name: 'Plant collection' });
    const active = within(group).getByRole('button', { name: 'Active' });
    const past = within(group).getByRole('button', { name: 'Past plants' });

    expect(active).toHaveAttribute('aria-pressed', 'true');
    expect(past).toHaveAttribute('aria-pressed', 'false');

    await user.click(past);

    expect(past).toHaveAttribute('aria-pressed', 'true');
    expect(active).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('PlantsPage space-manager disclosure', () => {
  it('reports whether the panel is open and points at it', async () => {
    const user = userEvent.setup();
    renderPlants();

    const toggle = await screen.findByRole('button', { name: /manage spaces/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const controls = toggle.getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    expect(document.getElementById(controls!)).not.toBeNull();
  });

  it('mounts the revealed panel after its trigger, so forward Tab reaches it', async () => {
    const user = userEvent.setup();
    renderPlants();

    const toggle = await screen.findByRole('button', { name: /manage spaces/i });
    await user.click(toggle);

    const panel = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    // DOCUMENT_POSITION_FOLLOWING === 4. The panel used to mount ~40 lines
    // earlier in the JSX, above the toggle, the search box and the collection
    // switch: pressing the button moved content in behind the user's focus
    // position, and Tab walked past it into the grid.
    expect(toggle.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('PlantsPage filter announcements', () => {
  it('announces how many plants matched what was typed', async () => {
    const user = userEvent.setup();
    renderPlants();
    await screen.findByText('Monstera');

    await user.type(screen.getByLabelText('Search plants'), 'monstera');

    const live = await screen.findByText(/plants match/i);
    expect(live.closest('[aria-live="polite"]')).not.toBeNull();
    expect(live).toHaveTextContent('2 plants match');
    expect(live).toHaveTextContent('monstera');
  });

  it('announces an emptied list rather than leaving the user in silence', async () => {
    const user = userEvent.setup();
    renderPlants();
    await screen.findByText('Monstera');

    await user.type(screen.getByLabelText('Search plants'), 'zzzz');

    const live = await screen.findByText(/0 plants match/i);
    expect(live.closest('[aria-live="polite"]')).not.toBeNull();
  });

  it('uses the singular for exactly one match', async () => {
    const user = userEvent.setup();
    renderPlants();
    await screen.findByText('Monstera');

    await user.type(screen.getByLabelText('Search plants'), 'fiddle');

    expect(await screen.findByText(/1 plant matches/i)).toBeInTheDocument();
  });

  it('says nothing at all while the read is still unsettled', async () => {
    // A failed or in-flight read must never announce "0 plants match": that is
    // a fact we do not have. Same three-state rule as the overdue chip.
    server.use(http.get(`${API}/plants`, () => new HttpResponse(null, { status: 500 })));
    const user = userEvent.setup();
    renderPlants();

    await screen.findByRole('alert');
    await user.type(screen.getByLabelText('Search plants'), 'monstera');

    expect(screen.queryByText(/plants? match/i)).not.toBeInTheDocument();
  });
});
