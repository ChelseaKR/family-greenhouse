import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { http, HttpResponse } from 'msw';
import { SitterLinksCard } from '@/features/household/SitterLinksCard';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';
const DAY = 24 * 60 * 60 * 1000;

/** Sign the card's viewer in as `role` of hh-1 (the role the backend resolves). */
function signInAs(role: 'admin' | 'member', id = 'user-1') {
  useAuthStore.setState({
    user: { id, email: 'me@example.com', name: 'Me', householdId: 'hh-1', householdRole: role },
    isAuthenticated: true,
    isLoading: false,
  } as never);
  server.use(
    http.get(`${API}/me/households`, () =>
      HttpResponse.json([{ householdId: 'hh-1', name: 'Home', role, joinedAt: '' }])
    )
  );
}

beforeEach(() => {
  useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: false } as never);
});

/**
 * The card's shared-links section is the only place an admin can revoke a
 * sitter link, so a FAILED read must not look like "no live links": that
 * rendered a card with no list, no error, and no Revoke control for links
 * that were still granting access to the household's task list.
 *
 * It is also the only place the household can see whether a neighbour's
 * access is open right now, so the state each row reports has to be the real
 * one — a row keeps `status: 'active'` for days after its window closes.
 */
function renderCard(
  links: unknown[] | 'fail',
  role: 'admin' | 'member' = 'admin',
  members: Array<{ userId: string; name: string }> = [],
  plan: 'seedling' | 'garden' | 'greenhouse' | 'fail' = 'garden'
) {
  signInAs(role);
  server.use(
    http.get(`${API}/households/hh-1/sitter-links`, () =>
      links === 'fail' ? new HttpResponse(null, { status: 500 }) : HttpResponse.json(links)
    ),
    http.get(`${API}/billing/me`, () =>
      plan === 'fail'
        ? new HttpResponse(null, { status: 500 })
        : HttpResponse.json({ planId: plan })
    )
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <SitterLinksCard householdId="hh-1" members={members} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

describe('SitterLinksCard existing-links read', () => {
  it('lists links that still work with a Revoke control when the read succeeds', async () => {
    renderCard([
      { id: 'l1', label: 'Neighbour', status: 'active', startsAt: iso(-DAY), expiresAt: iso(DAY) },
      { id: 'l2', label: 'Old', status: 'revoked', startsAt: iso(-DAY), expiresAt: iso(DAY) },
    ]);

    expect(await screen.findByText('Links you’ve shared')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Revoke sitter link Neighbour' })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Revoke sitter link Old' })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a member a Revoke control only on links they created, and names other creators', async () => {
    renderCard(
      [
        {
          id: 'l1',
          label: 'Mine',
          status: 'active',
          createdBy: 'user-1',
          startsAt: iso(-DAY),
          expiresAt: iso(DAY),
        },
        {
          id: 'l2',
          label: 'Theirs',
          status: 'active',
          createdBy: 'user-2',
          startsAt: iso(-DAY),
          expiresAt: iso(DAY),
        },
      ],
      'member',
      [{ userId: 'user-2', name: 'Sam' }]
    );

    expect(await screen.findByText('Links you’ve shared')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke sitter link Mine' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Revoke sitter link Theirs' })
    ).not.toBeInTheDocument();
    expect(screen.getByText('Shared by Sam')).toBeInTheDocument();
    expect(screen.getByText(/only its creator or an admin can revoke/i)).toBeInTheDocument();
  });

  it('lets an admin revoke every link, including ones other members created', async () => {
    renderCard(
      [
        {
          id: 'l2',
          label: 'Theirs',
          status: 'active',
          createdBy: 'user-2',
          startsAt: iso(-DAY),
          expiresAt: iso(DAY),
        },
      ],
      'admin'
    );

    expect(
      await screen.findByRole('button', { name: 'Revoke sitter link Theirs' })
    ).toBeInTheDocument();
    // Roster unknown for that id → honest fallback, never a made-up name.
    expect(screen.getByText('Shared by another member')).toBeInTheDocument();
  });

  it('shows nothing extra for a genuinely empty list', async () => {
    renderCard([]);

    expect(await screen.findByText('Plant-sitter links')).toBeInTheDocument();
    // Let the query settle, then assert the section stayed hidden with no error.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText('Links you’ve shared')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says the existing links could not be loaded instead of implying there are none', async () => {
    renderCard('fail');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn.t load your existing sitter links/i);
    expect(alert).toHaveTextContent(/still active/i);
    expect(screen.queryByText('Links you’ve shared')).not.toBeInTheDocument();
  });

  it('does not present a link whose window has closed as one that still works', async () => {
    // `status` stays 'active' well past expiresAt — the row outlives its own
    // window by the TTL buffer plus sweeper lag. Listing it as a live link
    // told the household a neighbour could still see their plants.
    renderCard([{ id: 'ended', label: 'Last summer', status: 'active', expiresAt: iso(-2 * DAY) }]);

    expect(await screen.findByText('Recently ended')).toBeInTheDocument();
    expect(screen.queryByText('Links you’ve shared')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Revoke sitter link Last summer/ })
    ).not.toBeInTheDocument();
    expect(screen.getByText(/no longer open anything/i)).toBeInTheDocument();
  });

  it('marks a link whose window has not opened yet as scheduled, not active', async () => {
    renderCard([
      {
        id: 'later',
        label: 'August trip',
        status: 'active',
        startsAt: iso(DAY),
        expiresAt: iso(9 * DAY),
      },
    ]);

    expect(await screen.findByText('Scheduled')).toBeInTheDocument();
    expect(screen.queryByText('Active')).not.toBeInTheDocument();
    // Still revocable — a plan can change before the trip does.
    expect(
      screen.getByRole('button', { name: 'Revoke sitter link August trip' })
    ).toBeInTheDocument();
  });
});

describe('SitterLinksCard creation window', () => {
  it('opens the link immediately when no start day is given', async () => {
    let body: Record<string, unknown> | undefined;
    server.use(
      http.get(`${API}/households/hh-1/sitter-links`, () => HttpResponse.json([])),
      http.post(`${API}/households/hh-1/sitter-links`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          {
            id: 'new',
            status: 'active',
            label: null,
            expiresAt: iso(14 * DAY),
            url: 'https://x/sit/t',
          },
          { status: 201 }
        );
      })
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <SitterLinksCard householdId="hh-1" />
      </QueryClientProvider>
    );

    await userEvent.click(await screen.findByRole('button', { name: /create sitter link/i }));

    await waitFor(() => expect(body).toBeDefined());
    expect(body?.startsAt).toBeUndefined();
  });

  it('schedules the window from the chosen start day rather than from today', async () => {
    // Creating the link a week before the trip used to spend a week of its own
    // window doing nothing, and left a neighbour with live access in the
    // meantime. The length is now counted from the day cover begins.
    let body: Record<string, unknown> | undefined;
    server.use(
      http.get(`${API}/households/hh-1/sitter-links`, () => HttpResponse.json([])),
      http.post(`${API}/households/hh-1/sitter-links`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          {
            id: 'new',
            status: 'active',
            label: null,
            startsAt: body.startsAt,
            expiresAt: body.expiresAt,
            url: 'https://x/sit/t',
          },
          { status: 201 }
        );
      })
    );
    server.use(http.get(`${API}/billing/me`, () => HttpResponse.json({ planId: 'garden' })));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SitterLinksCard householdId="hh-1" />
        </MemoryRouter>
      </QueryClientProvider>
    );

    const start = await screen.findByLabelText('Starts (optional)');
    await userEvent.type(start, '2099-07-01');
    const length = screen.getByLabelText('Lasts for (days)');
    await userEvent.clear(length);
    await userEvent.type(length, '5');
    await userEvent.click(screen.getByRole('button', { name: /create sitter link/i }));

    await waitFor(() => expect(body).toBeDefined());
    const startsAt = Date.parse(body!.startsAt as string);
    const expiresAt = Date.parse(body!.expiresAt as string);
    expect(expiresAt - startsAt).toBe(5 * DAY);
    // Local midnight on the chosen day, not "now" and not UTC midnight.
    expect(new Date(startsAt).getFullYear()).toBe(2099);
    expect(new Date(startsAt).getHours()).toBe(0);
  });
});

/**
 * The plan sets the longest window and how many links may be live (ADR
 * 0015). The card says which cap applies while the member types, bends the
 * default to it, and — on the free tier — turns the wall into an upgrade
 * prompt. An unsettled or failed plan read is stated as unknown: never the
 * free tier by assumption, never unlimited.
 */
describe('SitterLinksCard plan caps', () => {
  it('Seedling: caps the length input at 7, bends the default to it, and offers Garden', async () => {
    renderCard([], 'admin', [], 'seedling');

    const length = (await screen.findByLabelText('Lasts for (days)')) as HTMLInputElement;
    await waitFor(() => expect(length).toHaveAttribute('max', '7'));
    expect(length.value).toBe('7');
    expect(screen.getByText(/Up to 7 days on your plan/)).toBeInTheDocument();
    expect(screen.getByText(/Garden allows sitter links up to 90 days/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See plans' })).toHaveAttribute(
      'href',
      '/settings/billing'
    );
  });

  it('Garden: allows 90 days, keeps the 14-day default, and shows no upgrade prompt', async () => {
    renderCard([], 'admin', [], 'garden');

    const length = (await screen.findByLabelText('Lasts for (days)')) as HTMLInputElement;
    await waitFor(() => expect(length).toHaveAttribute('max', '90'));
    expect(length.value).toBe('14');
    expect(screen.getByText(/Up to 90 days on your plan/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'See plans' })).not.toBeInTheDocument();
  });

  it('says the cap is unknown when the plan read fails — not 7, not 90', async () => {
    renderCard([], 'admin', [], 'fail');

    expect(
      await screen.findByText(/couldn.t confirm your plan.s longest window/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/Up to 7 days/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Up to 90 days/)).not.toBeInTheDocument();
  });

  it('Seedling with one live link: explains the one-at-a-time cap and disables Create', async () => {
    renderCard(
      [
        {
          id: 'l1',
          label: 'Live',
          status: 'active',
          createdBy: 'user-1',
          startsAt: iso(-DAY),
          expiresAt: iso(DAY),
        },
      ],
      'admin',
      [],
      'seedling'
    );

    expect(
      await screen.findByText(/keeps 1 live sitter link at a time\. Revoke the current one/)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create sitter link/i })).toBeDisabled();
  });
});
