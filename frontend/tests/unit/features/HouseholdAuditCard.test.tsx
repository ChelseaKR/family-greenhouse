/**
 * The household audit log card (#675).
 *
 * What is worth asserting is not that a list renders. It is the three things
 * an admin reading this card relies on:
 *
 *   1. Names come from the server's answer — a current member by display
 *      name, anyone who has left as a former member, Stripe as Stripe — and
 *      each kind reads as a sentence about what happened.
 *   2. A failed read is never an empty log (ADR 0010). "Nothing recorded"
 *      tells an admin nobody has touched their keys; the card must only say
 *      it when the server said it.
 *   3. Paging reaches every page and says when it has, and a failed LATER
 *      page keeps what was read instead of pretending the log ends there.
 */
import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HouseholdAuditCard } from '@/features/household/HouseholdAuditCard';
import type { HouseholdAuditEntry } from '@/services/householdAuditService';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';
const ROUTE = `${API}/households/hh-1/audit`;

function renderCard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <HouseholdAuditCard householdId="hh-1" />
    </QueryClientProvider>
  );
}

function entry(over: Partial<HouseholdAuditEntry>): HouseholdAuditEntry {
  return {
    id: Math.random().toString(36).slice(2),
    kind: 'member.joined',
    occurredAt: '2026-09-18T12:00:00.000Z',
    actor: { type: 'member', name: 'Ada' },
    target: null,
    details: {},
    gapBefore: false,
    ...over,
  };
}

function page(items: HouseholdAuditEntry[], nextCursor: string | null = null) {
  return { retentionDays: 30, items, nextCursor };
}

describe('HouseholdAuditCard', () => {
  it('words each entry with the names the server resolved', async () => {
    server.use(
      http.get(ROUTE, () =>
        HttpResponse.json(
          page([
            entry({
              kind: 'member.removed',
              target: { type: 'former_member' },
              details: { role: 'member', sitterLinks: 2, plantTags: 1 },
            }),
            entry({
              kind: 'member.left',
              actor: { type: 'former_member' },
              details: { role: 'member', accountDeleted: true },
            }),
            entry({
              kind: 'member.role_changed',
              target: { type: 'member', name: 'Mel' },
              details: { from: 'member', to: 'admin' },
            }),
            entry({
              kind: 'api_key.created',
              details: { keyId: 'k1', last4: '9f3a', scopes: 'read:plants,write:tasks' },
            }),
            entry({ kind: 'invite.created', details: { channel: 'email' } }),
            entry({
              kind: 'billing.payment_failed',
              actor: { type: 'stripe' },
              details: { plan: 'greenhouse', status: 'past_due' },
            }),
            entry({
              kind: 'billing.plan_changed',
              actor: { type: 'stripe' },
              details: { plan: 'garden', status: 'trialing', via: 'checkout' },
            }),
            entry({ kind: 'trash.purged', details: { itemKind: 'task', itemId: 't1' } }),
          ])
        )
      )
    );
    renderCard();

    expect(await screen.findByText('Ada removed a former member from the household')).toBeVisible();
    expect(
      screen.getByText(/sitter links 2 · plant tags 1 · wall displays 0 · cutting links 0/)
    ).toBeInTheDocument();
    expect(screen.getByText('A former member left by deleting their account')).toBeInTheDocument();
    expect(screen.getByText('Ada made Mel an admin')).toBeInTheDocument();
    expect(screen.getByText('Ada created an API key ending in 9f3a')).toBeInTheDocument();
    expect(screen.getByText(/Access: read:plants, write:tasks/)).toBeInTheDocument();
    expect(screen.getByText('Ada sent an invitation by email')).toBeInTheDocument();
    expect(screen.getByText('A payment for Greenhouse failed')).toBeInTheDocument();
    expect(screen.getByText('A Garden free trial started')).toBeInTheDocument();
    expect(screen.getByText('Ada permanently deleted a task from the trash')).toBeInTheDocument();
    // A server that says there is nothing older gets the end-of-log line.
    expect(screen.getByText('That’s everything from the last 30 days.')).toBeInTheDocument();
  });

  it('falls back to a generic line for a kind this client does not know', async () => {
    server.use(http.get(ROUTE, () => HttpResponse.json(page([entry({ kind: 'webhook.added' })]))));
    renderCard();
    expect(
      await screen.findByText('A change to the household this version of the app can’t describe')
    ).toBeInTheDocument();
  });

  it('says so when an earlier write was lost, rather than showing a continuous log', async () => {
    server.use(
      http.get(ROUTE, () =>
        HttpResponse.json(page([entry({ kind: 'kiosk_link.revoked', gapBefore: true })]))
      )
    );
    renderCard();
    expect(
      await screen.findByText(
        'Something may be missing just before this entry: an earlier change could not be recorded.'
      )
    ).toBeInTheDocument();
  });

  it('shows the empty state only when the server says the log is empty', async () => {
    server.use(http.get(ROUTE, () => HttpResponse.json(page([]))));
    renderCard();
    expect(await screen.findByText('Nothing recorded yet')).toBeInTheDocument();
  });

  it('shows a failed read as an error with a retry — never as an empty log', async () => {
    let calls = 0;
    server.use(
      http.get(ROUTE, () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json({ message: 'boom' }, { status: 500 })
          : HttpResponse.json(page([entry({ kind: 'sitter_link.created' })]));
      })
    );
    const user = userEvent.setup();
    renderCard();

    expect(
      await screen.findByText(
        'We couldn’t load the audit log, so this is not a record of what happened. Nothing was changed.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByText('Nothing recorded yet')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Ada created a sitter link')).toBeInTheDocument();
  });

  it('pages with the server’s cursor until there is nothing older', async () => {
    const cursors: Array<string | null> = [];
    server.use(
      http.get(ROUTE, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        cursors.push(cursor);
        return cursor === 'page-2'
          ? HttpResponse.json(page([entry({ kind: 'household.created' })]))
          : HttpResponse.json(page([entry({ kind: 'member.joined' })], 'page-2'));
      })
    );
    const user = userEvent.setup();
    renderCard();

    expect(await screen.findByText('Ada joined with an invitation')).toBeInTheDocument();
    expect(screen.queryByText('That’s everything from the last 30 days.')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show older entries' }));

    expect(await screen.findByText('Ada created the household')).toBeInTheDocument();
    // The first page is still there: pages append.
    expect(screen.getByText('Ada joined with an invitation')).toBeInTheDocument();
    expect(screen.getByText('That’s everything from the last 30 days.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show older entries' })).not.toBeInTheDocument();
    expect(cursors).toEqual([null, 'page-2']);
  });

  it('keeps what it read when an older page fails, and says the older ones did not load', async () => {
    server.use(
      http.get(ROUTE, ({ request }) =>
        new URL(request.url).searchParams.get('cursor')
          ? HttpResponse.json({ message: 'boom' }, { status: 503 })
          : HttpResponse.json(page([entry({ kind: 'member.joined' })], 'page-2'))
      )
    );
    const user = userEvent.setup();
    renderCard();

    await user.click(await screen.findByRole('button', { name: 'Show older entries' }));

    await waitFor(() =>
      expect(
        screen.getByText('We couldn’t load the older entries. The ones above are still accurate.')
      ).toBeInTheDocument()
    );
    expect(screen.getByText('Ada joined with an invitation')).toBeInTheDocument();
    expect(screen.queryByText('That’s everything from the last 30 days.')).not.toBeInTheDocument();
  });
});
