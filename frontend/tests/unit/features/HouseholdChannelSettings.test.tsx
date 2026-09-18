import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { HouseholdChannelSettings } from '@/features/settings/HouseholdChannelSettings';
import { server } from '../../msw/server';

vi.mock('@/hooks/useActiveHouseholdId', () => ({
  useActiveHouseholdId: () => 'hh-1',
}));

const isAdmin = vi.hoisted(() => ({ value: true }));
vi.mock('@/hooks/useActiveHouseholdRole', () => ({
  useIsHouseholdAdmin: () => isAdmin.value,
  useActiveHouseholdRole: () => (isAdmin.value ? 'admin' : 'member'),
}));

const API = 'http://localhost:4000';

const connected = {
  platform: 'discord',
  maskedUrl: 'discord.com/…uvwx',
  events: { dailyDue: true, upForGrabs: true },
  quietStart: '',
  quietEnd: '',
  timezone: 'America/New_York',
  locale: 'en',
  status: 'active',
  disabledReason: null,
  lastFailure: null,
  lastDeliveredAt: '2026-09-18T12:00:00.000Z',
  nextAttemptAt: null,
  connectedAt: '2026-09-01T00:00:00.000Z',
};

/**
 * The chat-channel card (#674). Load-bearing behaviours:
 *
 *   - A FAILED read never renders as "not connected" (ADR 0010).
 *   - The address is typed into a password field and only the masked form is
 *     ever shown back.
 *   - A channel the server switched off is explained, with the way back.
 */
function renderCard(state: unknown | 'fail') {
  server.use(
    http.get(`${API}/households/hh-1/channel`, () =>
      state === 'fail' ? new HttpResponse(null, { status: 500 }) : HttpResponse.json(state)
    )
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <HouseholdChannelSettings />
    </QueryClientProvider>
  );
}

describe('HouseholdChannelSettings', () => {
  beforeEach(() => {
    isAdmin.value = true;
  });

  it('states what a post carries before anything is connected', async () => {
    renderCard({ available: true, channel: null });
    expect(
      await screen.findByText(/Posts carry plant names, task names and due dates only/i)
    ).toBeVisible();
    expect(screen.getByText(/No chat channel is connected/i)).toBeInTheDocument();
  });

  it('says it could not check when the read fails — not "not connected"', async () => {
    renderCard('fail');
    expect(
      await screen.findByText(/couldn’t check whether a chat channel is connected/i)
    ).toBeVisible();
    expect(screen.queryByText(/No chat channel is connected/i)).not.toBeInTheDocument();
  });

  it('takes the address in a password field and shows only the masked form back', async () => {
    renderCard({ available: true, channel: connected });
    expect(await screen.findByText(/Posting to Discord at discord.com\/…uvwx/)).toBeVisible();
    const field = screen.getByLabelText(/Incoming webhook address/i);
    expect(field).toHaveAttribute('type', 'password');
    expect(field).toHaveValue('');
    expect(screen.getByText(/Leave this blank to keep the address/i)).toBeInTheDocument();
  });

  it('explains a channel that was switched off, and how to reconnect', async () => {
    renderCard({
      available: true,
      channel: {
        ...connected,
        status: 'disabled',
        disabledReason: 'repeated_client_errors',
        lastFailure: { at: '2026-09-18T12:00:00.000Z', kind: 'client', httpStatus: 404 },
      },
    });
    expect(await screen.findByText(/Posting to this chat has stopped/i)).toBeVisible();
    expect(screen.getByText(/the webhook may have been deleted/i)).toBeVisible();
    expect(screen.getByText(/paste the webhook address again/i)).toBeVisible();
  });

  it('says when the environment cannot store a webhook, instead of a form that would fail', async () => {
    renderCard({ available: false, channel: null });
    expect(await screen.findByText(/aren’t available yet/i)).toBeVisible();
    expect(screen.queryByLabelText(/Incoming webhook address/i)).not.toBeInTheDocument();
  });

  it('connects, sending the address once, and shows a refused address in words', async () => {
    const bodies: unknown[] = [];
    let attempt = 0;
    server.use(
      http.put(`${API}/households/hh-1/channel`, async ({ request }) => {
        bodies.push(await request.json());
        attempt += 1;
        if (attempt === 1) {
          return HttpResponse.json(
            { message: 'nope', details: { code: 'private_host' } },
            { status: 400 }
          );
        }
        return HttpResponse.json({ available: true, channel: connected });
      })
    );
    renderCard({ available: true, channel: null });
    const user = userEvent.setup();
    const field = await screen.findByLabelText(/Incoming webhook address/i);
    await user.type(field, 'https://discord.com/api/webhooks/1/x');
    await user.click(screen.getByRole('button', { name: /Connect channel/i }));
    expect(
      await screen.findByText(/That server points into a private network/i)
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Connect channel/i }));
    await waitFor(() => expect(screen.getByText(/^Saved\.$/)).toBeInTheDocument());
    expect(bodies[0]).toMatchObject({
      platform: 'discord',
      url: 'https://discord.com/api/webhooks/1/x',
      events: { dailyDue: true, upForGrabs: true },
    });
  });

  it('reports a failed test post with its reason', async () => {
    server.use(
      http.post(`${API}/households/hh-1/channel/test`, () =>
        HttpResponse.json({
          outcome: 'failed',
          failure: { kind: 'client', httpStatus: 404 },
          channel: connected,
        })
      )
    );
    renderCard({ available: true, channel: connected });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Send a test message/i }));
    expect(
      await screen.findByText(/The test message didn’t go through: the chat service refused it/i)
    ).toBeVisible();
  });

  it('is admin-only and does not even ask the server otherwise', async () => {
    isAdmin.value = false;
    let asked = false;
    server.use(
      http.get(`${API}/households/hh-1/channel`, () => {
        asked = true;
        return HttpResponse.json({ available: true, channel: null });
      })
    );
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <HouseholdChannelSettings />
      </QueryClientProvider>
    );
    expect(await screen.findByText(/Only household admins can connect/i)).toBeVisible();
    expect(asked).toBe(false);
  });
});
