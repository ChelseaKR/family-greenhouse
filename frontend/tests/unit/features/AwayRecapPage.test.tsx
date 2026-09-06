/**
 * The return recap's whole value is that its states are distinguishable. An
 * empty recap is a CLAIM — "your sitter did nothing while you were away" —
 * so it must only ever be rendered when the server actually said so. These
 * tests pin the four ways that claim must NOT be made: a failed read, a
 * locked tier, no ended window, and a truncated scan.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AwayRecapPage } from '@/features/household/AwayRecapPage';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

function renderPage(initialEntry = '/away-recap') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AwayRecapPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const recap = {
  link: {
    id: 'link-1',
    label: 'The Smiths’ plants',
    startsAt: '2026-08-10T00:00:00.000Z',
    expiresAt: '2026-08-24T00:00:00.000Z',
    status: 'active',
    ended: true,
  },
  window: { from: '2026-08-10T00:00:00.000Z', to: '2026-08-24T00:00:00.000Z' },
  tasksCompleted: [
    {
      taskId: 't1',
      plantId: 'p1',
      plantName: 'Monstera',
      taskType: 'water',
      occurredAt: '2026-08-12T09:00:00.000Z',
      actorName: 'a plant sitter',
      notes: null,
    },
  ],
  photos: [
    {
      photoId: 'ph1',
      plantId: 'p1',
      plantName: 'Monstera',
      imageUrl: 'https://assets.example/plants/hh-1/p1/a.jpg',
      caption: 'New leaf!',
      occurredAt: '2026-08-13T09:00:00.000Z',
    },
  ],
  notes: [
    {
      source: 'photo',
      plantId: 'p1',
      plantName: 'Monstera',
      text: 'New leaf!',
      occurredAt: '2026-08-13T09:00:00.000Z',
    },
  ],
  counts: { tasks: 1, photos: 1, notes: 1 },
  truncated: false,
  generatedAt: '2026-08-25T00:00:00.000Z',
};

/** Every request the recap endpoint received, so a test can assert none. */
const recapRequests: string[] = [];

/**
 * The plan reads the page now makes BEFORE the recap. Defaults to an
 * entitled household so the state tests below still exercise what they were
 * written for.
 */
function servePlan({
  planId = 'garden',
  awayKit = true,
  plansStatus = 200,
}: { planId?: string; awayKit?: boolean; plansStatus?: number } = {}) {
  server.use(
    http.get(`${API}/billing/plans`, () =>
      plansStatus === 200
        ? HttpResponse.json({
            paymentsAvailable: true,
            plans: [
              {
                id: 'seedling',
                name: 'Seedling',
                description: '',
                maxPlants: 10,
                maxMembers: 3,
                features: { awayKit: false },
              },
              {
                id: 'garden',
                name: 'Garden',
                description: '',
                maxPlants: null,
                maxMembers: null,
                features: { awayKit },
              },
            ],
          })
        : HttpResponse.json({ message: 'boom' }, { status: plansStatus })
    ),
    http.get(`${API}/billing/me`, () => HttpResponse.json({ planId, status: 'active' }))
  );
}

function serveRecap(body: unknown, status = 200) {
  server.use(
    http.get(`${API}/households/hh-1/away-recap`, ({ request }) => {
      recapRequests.push(request.url);
      return status === 200 ? HttpResponse.json(body) : HttpResponse.json(body, { status });
    })
  );
}

describe('AwayRecapPage', () => {
  beforeEach(() => {
    recapRequests.length = 0;
    // Entitled by default; the entitlement tests override it.
    servePlan();
    useAuthStore.setState({
      isAuthenticated: true,
      idToken: 'id-token-1',
      user: {
        id: 'user-1',
        email: 'alice@example.com',
        name: 'Alice',
        householdId: 'hh-1',
        // A plain MEMBER: the recap is not admin-only.
        householdRole: 'member',
      },
    } as never);
  });

  it('replays what the sitter did, with counts, tasks, photos and notes', async () => {
    serveRecap(recap);
    renderPage();

    expect(await screen.findByText(/The Smiths’ plants/)).toBeInTheDocument();
    expect(screen.getByText(/water — Monstera/)).toBeInTheDocument();
    expect(screen.getByText(/by a plant sitter/)).toBeInTheDocument();
    expect(screen.getByAltText('New leaf!')).toBeInTheDocument();
    expect(screen.getByText(/Monstera: New leaf!/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders a failed read as "couldn’t load", never as an empty recap', async () => {
    serveRecap({ message: 'boom' }, 500);
    renderPage();

    expect(await screen.findByText(/We couldn’t load your recap/)).toBeInTheDocument();
    expect(screen.getByText(/not the same as nothing having happened/)).toBeInTheDocument();
    // None of the recap's own scaffolding is shown.
    expect(screen.queryByText(/Tasks your sitter checked off/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Nothing was recorded/)).not.toBeInTheDocument();
  });

  it('distinguishes "no window has ended yet" (404) from an empty recap', async () => {
    serveRecap({ message: 'No sitter window has ended yet' }, 404);
    renderPage();

    expect(await screen.findByText(/No sitter window has ended yet/)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing was recorded/)).not.toBeInTheDocument();
    expect(screen.queryByText(/We couldn’t load your recap/)).not.toBeInTheDocument();
  });

  it('shows the locked state on 402 rather than an error or an empty recap', async () => {
    // Defence in depth: if the plan read says entitled and the server
    // disagrees, the 402 must still land on the locked state.
    serveRecap({ message: 'nope' }, 402);
    renderPage();

    expect(await screen.findByText(/The Away Kit is part of Garden/)).toBeInTheDocument();
    expect(screen.queryByText(/We couldn’t load your recap/)).not.toBeInTheDocument();
  });

  it('never calls the paid endpoint on a household without the Away Kit', async () => {
    // The 402 was handled correctly and was still a defect: the browser logs
    // every non-2xx response as a console error before any of our code runs,
    // which is what fails the E2E console assertions. The fix is to not make
    // the request.
    servePlan({ planId: 'seedling', awayKit: false });
    serveRecap(recap);
    renderPage();

    expect(await screen.findByText(/The Away Kit is part of Garden/)).toBeInTheDocument();
    expect(recapRequests).toEqual([]);
  });

  it('says it could not check the plan rather than claiming the Away Kit is missing', async () => {
    // A failed catalog read is not "your plan doesn't include it", and it is
    // not an empty recap either (ADR 0010).
    servePlan({ plansStatus: 500 });
    serveRecap(recap);
    renderPage();

    expect(await screen.findByText(/We couldn’t check your plan/)).toBeInTheDocument();
    expect(screen.queryByText(/The Away Kit is part of Garden/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Nothing was recorded/)).not.toBeInTheDocument();
    expect(recapRequests).toEqual([]);
  });

  it('still fetches and renders the recap for an entitled household', async () => {
    // The gate must not become a wall: the whole point is that Garden
    // households are unaffected.
    servePlan({ planId: 'garden', awayKit: true });
    serveRecap(recap);
    renderPage();

    expect(await screen.findByText(/The Smiths’ plants/)).toBeInTheDocument();
    expect(recapRequests).toHaveLength(1);
  });

  it('states plainly when the window really was quiet — a settled zero, not a failure', async () => {
    serveRecap({
      ...recap,
      tasksCompleted: [],
      photos: [],
      notes: [],
      counts: { tasks: 0, photos: 0, notes: 0 },
    });
    renderPage();

    expect(await screen.findByText(/Nothing was recorded in this window/)).toBeInTheDocument();
    expect(screen.getByText(/isn’t a loading problem/)).toBeInTheDocument();
  });

  it('says so when the scan was truncated instead of presenting a prefix as the whole story', async () => {
    serveRecap({ ...recap, truncated: true });
    renderPage();

    expect(await screen.findByText(/This recap is partial/)).toBeInTheDocument();
    expect(screen.getByText(/only the beginning of it/)).toBeInTheDocument();
  });

  it('passes an explicit linkId through to the API', async () => {
    let seen: string | null = null;
    server.use(
      http.get(`${API}/households/hh-1/away-recap`, ({ request }) => {
        seen = new URL(request.url).searchParams.get('linkId');
        return HttpResponse.json(recap);
      })
    );
    renderPage('/away-recap?linkId=link-9');

    expect(await screen.findByText(/The Smiths’ plants/)).toBeInTheDocument();
    expect(seen).toBe('link-9');
  });
});
