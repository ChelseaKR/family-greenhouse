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

function serveRecap(body: unknown, status = 200) {
  server.use(
    http.get(`${API}/households/hh-1/away-recap`, () =>
      status === 200 ? HttpResponse.json(body) : HttpResponse.json(body, { status })
    )
  );
}

describe('AwayRecapPage', () => {
  beforeEach(() => {
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
    serveRecap({ message: 'nope' }, 402);
    renderPage();

    expect(await screen.findByText(/The Away Kit is part of Garden/)).toBeInTheDocument();
    expect(screen.queryByText(/We couldn’t load your recap/)).not.toBeInTheDocument();
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
