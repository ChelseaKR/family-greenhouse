/**
 * The printed plant passport (#676), rendered against the real services over
 * MSW. What it pins:
 *
 *   - Private notes never reach the page by default, and a non-admin cannot
 *     put them there at all. Only an admin's explicit tick does.
 *   - Whoever did the care is initials by default; completion notes never
 *     appear, with or without full names.
 *   - The house rule is the only care note, and its absence is stated (#599).
 *   - Pet safety comes from the curated table's endpoint, never the Perenual
 *     species detail; an unknown plant makes no claim either way.
 *   - A failed history read is stated as missing, never as "no care".
 *   - The QR code is opt-in: loading the page mints no share link.
 *   - Every control sits in the one panel the print stylesheet hides, and
 *     the page has no axe violations.
 *
 * Absence assertions are paired with NEGATIVE CONTROLS in the same render: the
 * secret is shown to be in the served payload and to become visible when the
 * guard is deliberately switched off, so "not in the document" cannot pass
 * because the fixture never carried it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { axe, toHaveNoViolations } from 'jest-axe';
import { PlantPassportPage } from '@/features/plants/PlantPassportPage';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

expect.extend(toHaveNoViolations);

declare module 'vitest' {
  interface Assertion {
    toHaveNoViolations(): void;
  }
}

const API = 'http://localhost:4000';
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const SECRET_NOTE = 'Spare key is under the blue pot';
const SECRET_COMPLETION_NOTE = 'Neighbor at no. 12 waters when we are away';
const MEMBER_NAME = 'Chelsea Kelly-Reif';
const SHARE_CODE = 'b'.repeat(32);

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

interface Fixture {
  role?: 'admin' | 'member';
  careRule?: string | null;
  notes?: string | null;
  species?: string | null;
  history?: 'ok' | 'fail';
  toxicity?: 'match' | 'none' | 'fail';
}

function plantPayload(fixture: Fixture) {
  return {
    id: 'p1',
    householdId: 'hh-1',
    name: 'Kitchen Pothos',
    species: fixture.species === undefined ? 'Epipremnum aureum' : fixture.species,
    speciesSource: 'catalog',
    location: 'Kitchen',
    placementNote: 'Top shelf by the kettle',
    imageUrl: null,
    notes: fixture.notes === undefined ? SECRET_NOTE : fixture.notes,
    careRule:
      fixture.careRule === undefined ? 'Water only when the top inch is dry' : fixture.careRule,
    status: 'active',
    createdAt: daysAgo(400),
    createdBy: 'u1',
    updatedAt: daysAgo(1),
    upcomingTasks: [
      {
        id: 't1',
        plantId: 'p1',
        plantName: 'Kitchen Pothos',
        type: 'water',
        frequency: 7,
        seasonalCadences: [{ season: 'winter', frequency: 14 }],
        lastCompleted: daysAgo(2),
        nextDue: daysAgo(-5),
        assignedTo: 'u1',
        assignedToName: MEMBER_NAME,
        notes: 'Task note that stays home',
        createdBy: 'u1',
        createdAt: daysAgo(400),
      },
    ],
    recentCompletions: [],
    lineage: {
      parent: { id: 'p0', name: 'Grandma’s Pothos', status: 'active' },
      children: [{ id: 'p2', name: 'Office cutting', status: 'gave_away', createdAt: daysAgo(30) }],
    },
  };
}

const HISTORY = [
  {
    id: 'c1',
    householdId: 'hh-1',
    plantId: 'p1',
    taskId: 't1',
    taskType: 'water',
    completedBy: 'u1',
    completedByName: MEMBER_NAME,
    completedAt: daysAgo(2),
    notes: SECRET_COMPLETION_NOTE,
  },
  {
    id: 'c2',
    householdId: 'hh-1',
    plantId: 'p1',
    taskId: 't1',
    taskType: 'water',
    completedBy: 'u2',
    completedByName: 'Joyce',
    completedAt: daysAgo(9),
    notes: null,
  },
];

const POTHOS_MATCH = {
  slug: 'pothos',
  commonName: 'Pothos',
  scientificName: 'Epipremnum aureum',
  cats: 'toxic',
  dogs: 'toxic',
  note: 'The sap carries insoluble calcium oxalate crystals.',
};

/** Serves the page's reads; returns counters for the requests that matter. */
function serve(fixture: Fixture = {}) {
  const calls = { share: 0, perenual: 0, toxicityQueries: [] as string[] };
  const role = fixture.role ?? 'admin';
  useAuthStore.setState({
    accessToken: 'access-1',
    user: {
      id: 'u1',
      email: 'test@example.com',
      name: MEMBER_NAME,
      householdId: 'hh-1',
      householdRole: role,
    },
    activeHouseholdId: 'hh-1',
  });
  server.use(
    http.get(`${API}/me/households`, () =>
      HttpResponse.json([{ householdId: 'hh-1', name: 'Home', role, joinedAt: '' }])
    ),
    http.get(`${API}/plants/p1`, () => HttpResponse.json(plantPayload(fixture))),
    http.get(`${API}/plants/p1/history`, () =>
      fixture.history === 'fail'
        ? HttpResponse.json({ message: 'boom' }, { status: 500 })
        : HttpResponse.json(HISTORY)
    ),
    http.get(`${API}/species/toxicity`, ({ request }) => {
      const q = new URL(request.url).searchParams.get('q') ?? '';
      calls.toxicityQueries.push(q);
      if (fixture.toxicity === 'fail') return HttpResponse.json({}, { status: 503 });
      const hit = (fixture.toxicity ?? 'match') === 'match' && q === 'Epipremnum aureum';
      return HttpResponse.json({ query: q, results: hit ? [POTHOS_MATCH] : [] });
    }),
    // The Perenual species detail is the WRONG source for a pet claim. It is
    // served here only so that a call to it is counted rather than erroring.
    http.get(`${API}/species/:id`, () => {
      calls.perenual += 1;
      return HttpResponse.json({ status: 'found', result: { poisonousToPets: false } });
    }),
    http.post(`${API}/plants/p1/share`, () => {
      calls.share += 1;
      return HttpResponse.json({
        code: SHARE_CODE,
        url: `https://familygreenhouse.net/shared/${SHARE_CODE}`,
        expiresAt: '2026-10-01T12:00:00.000Z',
      });
    })
  );
  return calls;
}

function renderPassport() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/plants/p1/passport']}>
        <Routes>
          <Route path="/plants/:plantId/passport" element={<PlantPassportPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

/** Waits until both slow reads have settled, which is when Print enables. */
async function settled() {
  const print = await screen.findByRole('button', { name: 'Print passport' });
  await waitFor(() => expect(print).toBeEnabled());
  return screen.getByTestId('plant-passport');
}

beforeEach(() => {
  useAuthStore.setState({ accessToken: null, user: null, activeHouseholdId: null } as never);
});

describe('PlantPassportPage — privacy defaults', () => {
  it('leaves the private notes off by default, and prints them only when an admin ticks the box', async () => {
    const user = userEvent.setup();
    serve({ role: 'admin' });
    renderPassport();
    const sheet = await settled();

    expect(within(sheet).queryByText(SECRET_NOTE)).not.toBeInTheDocument();
    expect(within(sheet).queryByText('Notes from the household')).not.toBeInTheDocument();

    // NEGATIVE CONTROL: the notes really are in the payload this page read,
    // and the same assertion DOES see them once the guard is opened — so the
    // absence above is the default working, not a fixture with nothing in it.
    const box = screen.getByRole('checkbox', { name: 'Include my notes' });
    expect(box).not.toBeChecked();
    await user.click(box);
    expect(within(sheet).getByTestId('passport-notes')).toHaveTextContent(SECRET_NOTE);
    expect(within(sheet).getByText('Notes from the household')).toBeInTheDocument();

    // And unticking takes them straight back off the sheet.
    await user.click(box);
    expect(within(sheet).queryByText(SECRET_NOTE)).not.toBeInTheDocument();
  });

  it('gives a plain member no way to include the notes', async () => {
    serve({ role: 'member' });
    renderPassport();
    const sheet = await settled();

    expect(screen.queryByRole('checkbox', { name: 'Include my notes' })).not.toBeInTheDocument();
    expect(within(sheet).queryByText(SECRET_NOTE)).not.toBeInTheDocument();
    // Control: the member-side render is complete — the other option is there.
    expect(
      screen.getByRole('checkbox', { name: 'Show the full names of who did the care' })
    ).toBeInTheDocument();
  });

  it('prints initials for who did the care, and never a completion note', async () => {
    const user = userEvent.setup();
    serve();
    renderPassport();
    const sheet = await settled();

    const table = within(sheet).getByRole('table');
    expect(within(table).getByText('CK')).toBeInTheDocument();
    expect(within(table).getByText('J')).toBeInTheDocument();
    expect(within(sheet).queryByText(MEMBER_NAME)).not.toBeInTheDocument();
    expect(sheet).not.toHaveTextContent(SECRET_COMPLETION_NOTE);
    // Nor the task's note, its assignee, or where the plant sits at home.
    expect(sheet).not.toHaveTextContent('Task note that stays home');
    expect(sheet).not.toHaveTextContent('Top shelf by the kettle');

    // NEGATIVE CONTROL: the full name is in the served history and becomes
    // visible when asked for — while the completion note still does not.
    await user.click(
      screen.getByRole('checkbox', { name: 'Show the full names of who did the care' })
    );
    expect(within(table).getByText(MEMBER_NAME)).toBeInTheDocument();
    expect(sheet).not.toHaveTextContent(SECRET_COMPLETION_NOTE);
  });
});

describe('PlantPassportPage — what it says', () => {
  it('prints the name, species, house rule, schedule, window and lineage', async () => {
    serve();
    renderPassport();
    const sheet = await settled();

    expect(within(sheet).getByRole('heading', { level: 2, name: 'Kitchen Pothos' })).toBeVisible();
    expect(within(sheet).getByText('Epipremnum aureum')).toBeInTheDocument();
    expect(within(sheet).getByText('Species chosen from the plant catalog.')).toBeInTheDocument();
    expect(within(sheet).getByText('Water only when the top inch is dry')).toBeInTheDocument();
    expect(sheet).toHaveTextContent('Water — every 7 days');
    expect(sheet).toHaveTextContent('By season: winter: every 14 days');
    expect(
      within(sheet).getByText('2 care entries logged in the last 90 days.')
    ).toBeInTheDocument();
    expect(within(sheet).getByText('Grandma’s Pothos')).toBeInTheDocument();
    expect(sheet).toHaveTextContent('Office cutting');
    expect(sheet).toHaveTextContent('Gave away');
  });

  it('says there is no house rule — and does not fill the gap with the notes', async () => {
    serve({ careRule: null });
    renderPassport();
    const sheet = await settled();

    expect(
      within(sheet).getByText('No house rule was written for this plant.')
    ).toBeInTheDocument();
    expect(sheet).not.toHaveTextContent(SECRET_NOTE);
  });

  it('states a failed history read as missing, never as "no care"', async () => {
    serve({ history: 'fail' });
    renderPassport();
    const sheet = await settled();

    expect(within(sheet).getByText(/care history couldn’t be loaded/i)).toBeInTheDocument();
    expect(within(sheet).queryByText(/No care was logged/i)).not.toBeInTheDocument();
    expect(within(sheet).queryByRole('table')).not.toBeInTheDocument();
  });

  it('takes pet safety from the curated table, never the Perenual detail', async () => {
    const calls = serve();
    renderPassport();
    const sheet = await settled();

    const pet = within(sheet).getByTestId('passport-pet-safety');
    expect(pet).toHaveTextContent('Keep away from pets');
    expect(pet).toHaveTextContent('matched to Pothos (Epipremnum aureum)');
    expect(pet).toHaveTextContent('ASPCA');
    expect(calls.toxicityQueries).toEqual(['Epipremnum aureum']);
    expect(calls.perenual).toBe(0);
  });

  it('makes no pet claim either way for a plant the table does not know', async () => {
    const calls = serve({ toxicity: 'none' });
    renderPassport();
    const sheet = await settled();

    expect(within(sheet).getByText(/isn’t on our verified pet-safety list/)).toBeInTheDocument();
    expect(within(sheet).queryByText(/non-toxic/i)).not.toBeInTheDocument();
    expect(within(sheet).queryByTestId('passport-pet-safety')).not.toBeInTheDocument();
    // Species first, then the display name — the sitter brief's order.
    expect(calls.toxicityQueries).toEqual(['Epipremnum aureum', 'Kitchen Pothos']);
  });

  it('says it could not check pet safety when the lookup fails', async () => {
    serve({ toxicity: 'fail' });
    renderPassport();
    const sheet = await settled();

    expect(within(sheet).getByText(/Pet safety couldn’t be checked/)).toBeInTheDocument();
    expect(within(sheet).queryByText(/non-toxic/i)).not.toBeInTheDocument();
  });
});

describe('PlantPassportPage — QR code and print', () => {
  it('mints no share link until asked, then prints its QR code and address', async () => {
    const user = userEvent.setup();
    const calls = serve();
    renderPassport();
    const sheet = await settled();

    expect(calls.share).toBe(0);
    expect(within(sheet).queryByRole('img', { name: /QR code/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add a QR code' }));

    expect(
      await within(sheet).findByRole('img', {
        name: 'QR code for the share link to Kitchen Pothos',
      })
    ).toBeInTheDocument();
    expect(sheet).toHaveTextContent(`https://familygreenhouse.net/shared/${SHARE_CODE}`);
    expect(calls.share).toBe(1);
    expect(screen.queryByRole('button', { name: 'Add a QR code' })).not.toBeInTheDocument();
  });

  it('keeps every control out of the printed sheet', async () => {
    serve();
    renderPassport();
    const sheet = await settled();

    const controls = screen.getByTestId('passport-controls');
    // jsdom has no print media, so pin the mechanism: every button and
    // checkbox on the page is inside the one panel the print variant hides,
    // and the sheet itself holds none.
    expect(controls.className).toMatch(/(^|\s)print:hidden(\s|$)/);
    for (const control of [...screen.getAllByRole('button'), ...screen.getAllByRole('checkbox')]) {
      expect(controls.contains(control), control.outerHTML).toBe(true);
    }
    expect(within(sheet).queryAllByRole('button')).toHaveLength(0);
    expect(within(sheet).queryAllByRole('checkbox')).toHaveLength(0);
    expect(within(sheet).queryAllByRole('link')).toHaveLength(0);
    // The one link on the page, back to the plant, rides in a hidden header.
    const back = screen.getByRole('link', { name: 'Back to Kitchen Pothos' });
    expect(back.closest('header')?.className).toMatch(/(^|\s)print:hidden(\s|$)/);
  });

  it('has no axe violations', async () => {
    serve();
    const { container } = renderPassport();
    await settled();

    expect(
      await axe(container, { runOnly: { type: 'tag', values: WCAG_TAGS } })
    ).toHaveNoViolations();
  });
});
