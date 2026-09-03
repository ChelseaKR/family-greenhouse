import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { SitterLinksCard } from '@/features/household/SitterLinksCard';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';
const DAY = 24 * 60 * 60 * 1000;

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
function renderCard(links: unknown[] | 'fail') {
  server.use(
    http.get(`${API}/households/hh-1/sitter-links`, () =>
      links === 'fail' ? new HttpResponse(null, { status: 500 }) : HttpResponse.json(links)
    )
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SitterLinksCard householdId="hh-1" />
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
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <SitterLinksCard householdId="hh-1" />
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
