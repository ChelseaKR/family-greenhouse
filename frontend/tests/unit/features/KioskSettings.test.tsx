import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { KioskSettings } from '@/features/settings/KioskSettings';
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

/**
 * The kiosk card is the only place a household can turn a permanently
 * displayed credential off, so two behaviours are load-bearing:
 *
 *   - A FAILED read must not render as "no wall display is running". That
 *     would tell an admin nothing is showing their task list at the exact
 *     moment we could not check (ADR 0010).
 *   - The cost of each refresh interval is on the control, not in a doc,
 *     because this is the one feature billed by wall-clock time.
 */
function renderCard(link: unknown | 'fail') {
  server.use(
    http.get(`${API}/households/hh-1/kiosk-link`, () =>
      link === 'fail' ? new HttpResponse(null, { status: 500 }) : HttpResponse.json({ link })
    )
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <KioskSettings />
    </QueryClientProvider>
  );
}

const activeLink = {
  id: 'k1',
  householdId: 'hh-1',
  createdBy: 'u1',
  createdAt: '2026-08-01T00:00:00.000Z',
  status: 'active',
  pollIntervalSeconds: 300,
};

describe('KioskSettings', () => {
  beforeEach(() => {
    isAdmin.value = true;
  });

  it('warns that the displayed address is the password', async () => {
    renderCard(null);
    expect(
      await screen.findByText(/The web address on the display is the password/i)
    ).toBeVisible();
  });

  it('reports "no wall display" only when the read actually succeeded', async () => {
    renderCard(null);
    expect(await screen.findByText(/No wall display is set up/i)).toBeInTheDocument();
  });

  it('says it could not check when the read fails — not "no display"', async () => {
    renderCard('fail');
    expect(
      await screen.findByText(/couldn’t check whether a wall display is running/i)
    ).toBeVisible();
    expect(screen.queryByText(/No wall display is set up/i)).not.toBeInTheDocument();
  });

  it('shows a live display with a revoke control', async () => {
    renderCard(activeLink);
    expect(await screen.findByText(/A wall display has been running since/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Turn the display off/i })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Issue a new link \(revokes the old one\)/i })
    ).toBeInTheDocument();
  });

  it('prices every refresh interval on the control itself', async () => {
    renderCard(null);
    await screen.findByText(/No wall display is set up/i);
    const select = screen.getByLabelText(/How often the display refreshes/i);
    expect(select).toHaveValue('300');
    // The cost is stated where the choice is made, because this feature's
    // bill scales with wall-clock time rather than usage.
    expect(
      screen.getByRole('option', { name: /Every 5 minutes \(about \$0.01 per month\)/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: /Every minute \(about \$0.05 per month\)/ })
    ).toBeInTheDocument();
  });

  it('issues a link and shows the URL exactly once', async () => {
    server.use(
      http.post(`${API}/households/hh-1/kiosk-link`, () =>
        HttpResponse.json({ ...activeLink, token: 'a'.repeat(64), url: 'https://x.test/kiosk/aaa' })
      )
    );
    renderCard(null);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /Set up a wall display/i }));

    await waitFor(() =>
      expect(screen.getByLabelText(/Wall display link/i)).toHaveValue('https://x.test/kiosk/aaa')
    );
    expect(screen.getByText(/we won’t show the full link again/i)).toBeInTheDocument();
  });

  it('surfaces the Greenhouse gate when the plan does not include the kiosk', async () => {
    server.use(
      http.post(`${API}/households/hh-1/kiosk-link`, () =>
        HttpResponse.json(
          { message: 'The kiosk display is included with the Greenhouse plan.' },
          { status: 402 }
        )
      )
    );
    renderCard(null);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /Set up a wall display/i }));
    expect(await screen.findByText(/included with the Greenhouse plan/i)).toBeInTheDocument();
  });

  it('tells a non-admin why the controls are disabled', async () => {
    isAdmin.value = false;
    renderCard(null);
    expect(await screen.findByText(/Only household admins/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Set up a wall display/i })).toBeDisabled();
  });
});
