/**
 * The "Going away?" upgrade moment (2026-10-23).
 *
 * Three triggers on the sitter-link form, for a free household only: a length
 * past the free plan's longest link, the free plan's one live link already in
 * use, and arriving from the dashboard's "Going away soon?" card. And the
 * things it must never do: block the free link, make an offer off a read that
 * did not land, offer Garden to a household that has it, or sell inside the
 * apps.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { http, HttpResponse } from 'msw';
import { SitterLinksCard } from '@/features/household/SitterLinksCard';
import { GoingAwaySoonCard, GOING_AWAY_ROUTE } from '@/features/dashboard/GoingAwaySoonCard';
import { useAuthStore } from '@/store/authStore';
import { usePrefsStore } from '@/store/prefsStore';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';
const DAY = 24 * 60 * 60 * 1000;

const plan = (
  id: string,
  name: string,
  sitterLinkMaxDays: number,
  sitterLinksActive: number,
  awayKit: boolean,
  monthlyPrice?: number
) => ({
  id,
  name,
  description: '',
  maxPlants: 20,
  maxMembers: 3,
  ...(monthlyPrice === undefined ? {} : { monthlyPrice }),
  limits: {
    homes: 1,
    members: 3,
    plants: 20,
    tags: 0,
    analyticsHistoryDays: 30,
    sitterLinkMaxDays,
    sitterLinksActive,
  },
  features: {
    awayKit,
    householdToolkit: awayKit,
    plantTags: awayKit,
    crossHomeToday: false,
    kiosk: false,
    caretakerSeats: false,
    moveDay: awayKit,
    chat: awayKit,
    apiKeys: false,
  },
});

const PLANS = [
  plan('seedling', 'Seedling', 7, 1, false),
  plan('garden', 'Garden', 90, 10, true, 4.99),
  plan('greenhouse', 'Greenhouse', 90, 25, true, 9.99),
];

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const LIVE_LINK = {
  id: 'l1',
  label: 'Neighbor',
  status: 'active',
  createdBy: 'u-me',
  startsAt: iso(-DAY),
  expiresAt: iso(3 * DAY),
};

interface Setup {
  role?: 'admin' | 'member';
  planId?: 'seedling' | 'garden';
  links?: unknown[];
  plansStatus?: number;
  noCardTrial?: { state: 'active' | 'ended'; endsAt: string };
}

/** Every read the card makes, and a record of the links it creates. */
function stub({
  role = 'admin',
  planId = 'seedling',
  links = [],
  plansStatus = 200,
  noCardTrial,
}: Setup = {}) {
  useAuthStore.setState({
    user: {
      id: 'u-me',
      email: 'me@example.com',
      name: 'Sam',
      householdId: 'hh-1',
      householdRole: role,
    },
    isAuthenticated: true,
    isLoading: false,
  } as never);
  const created: Array<{ expiresAt: string; startsAt?: string }> = [];
  const plansRequests: number[] = [];
  server.use(
    http.get(`${API}/me/households`, () =>
      HttpResponse.json([{ householdId: 'hh-1', name: 'Home', role, joinedAt: '' }])
    ),
    http.get(`${API}/plants`, () => HttpResponse.json([{ id: 'p1', name: 'Pothos' }])),
    http.get(`${API}/households/hh-1/sitter-links`, () => HttpResponse.json(links)),
    http.post(`${API}/households/hh-1/sitter-links`, async ({ request }) => {
      const body = (await request.json()) as { expiresAt: string; startsAt?: string };
      created.push(body);
      return HttpResponse.json({
        id: 'l-new',
        token: 'tok',
        url: 'https://familygreenhouse.net/sit/tok',
        status: 'active',
        startsAt: body.startsAt ?? new Date().toISOString(),
        expiresAt: body.expiresAt,
      });
    }),
    http.get(`${API}/billing/plans`, () => {
      plansRequests.push(plansStatus);
      return plansStatus === 200
        ? HttpResponse.json({
            paymentsAvailable: true,
            commercialHold: { active: false, effectiveDate: '2026-09-01' },
            plans: PLANS,
          })
        : HttpResponse.json({ message: 'nope' }, { status: plansStatus });
    }),
    http.get(`${API}/billing/me`, () =>
      HttpResponse.json({ planId, ...(noCardTrial ? { noCardTrial } : {}) })
    ),
    http.get(`${API}/households/hh-1`, () =>
      HttpResponse.json({
        id: 'hh-1',
        name: 'Home',
        createdAt: '',
        createdBy: 'u-admin',
        members: [
          { userId: 'u-admin', name: 'Maria', role: 'admin', joinedAt: '' },
          { userId: 'u-me', name: 'Sam', role, joinedAt: '' },
        ],
      })
    )
  );
  return { created, plansRequests };
}

function renderCard(showAwayOffer = false) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <SitterLinksCard householdId="hh-1" showAwayOffer={showAwayOffer} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

async function typeLength(user: ReturnType<typeof userEvent.setup>, days: string) {
  const input = await screen.findByLabelText(/lasts for/i);
  // Wait for the plan read, so the cap the card knows is the real one.
  await screen.findByText(/up to \d+ days on your plan/i);
  await user.clear(input);
  await user.type(input, days);
  return input;
}

beforeEach(() => {
  delete (window as { Capacitor?: unknown }).Capacitor;
  usePrefsStore.setState({ goingAwayDismissedUntil: {} });
});

afterEach(() => {
  delete (window as { Capacitor?: unknown }).Capacitor;
});

describe('Going away? on the sitter-link form', () => {
  it('offers Garden, with the catalog price, when a free household types a longer trip', async () => {
    const user = userEvent.setup();
    stub();
    renderCard();

    await typeLength(user, '14');

    const offer = await screen.findByTestId('going-away-offer');
    expect(offer).toHaveAttribute('data-reason', 'longer');
    const scoped = within(offer);
    expect(scoped.getByRole('heading', { name: 'Away for more than 7 days?' })).toBeVisible();
    expect(scoped.getByText(/Garden is \$4\.99 a month for the whole household/)).toBeVisible();
    expect(
      scoped.getByText('Sitter links of up to 90 days, with up to 10 live at once')
    ).toBeVisible();
    expect(scoped.getByText(/printable care brief/i)).toBeVisible();
    expect(
      scoped.getByRole('link', { name: 'Upgrade to Garden for $4.99 a month' })
    ).toHaveAttribute('href', '/settings/billing');
    expect(scoped.getByText(/your free 7-day link is still yours/i)).toBeVisible();
  });

  it('never blocks the free link: one tap goes back to 7 days and the link is created', async () => {
    const user = userEvent.setup();
    const { created } = stub();
    renderCard();

    const input = await typeLength(user, '21');
    await user.click(await screen.findByRole('button', { name: 'Use 7 days instead' }));

    expect(input).toHaveValue(7);
    expect(screen.queryByTestId('going-away-offer')).toBeNull();
    await user.click(screen.getByRole('button', { name: /create sitter link/i }));

    expect(await screen.findByText('Your sitter link is ready')).toBeVisible();
    expect(created).toHaveLength(1);
    const days = (Date.parse(created[0].expiresAt) - Date.now()) / DAY;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7);
  });

  it('offers Garden when the free plan’s one live link is already in use', async () => {
    stub({ links: [LIVE_LINK] });
    renderCard();

    const offer = await screen.findByTestId('going-away-offer');
    expect(offer).toHaveAttribute('data-reason', 'second');
    expect(
      within(offer).getByRole('heading', { name: 'Need a second sitter link?' })
    ).toBeVisible();
    expect(within(offer).getByText(/your current link keeps working/i)).toBeVisible();
    // The existing cap notice still says what the plan allows.
    expect(screen.getByText(/keeps 1 live sitter link at a time/i)).toBeVisible();
  });

  it('shows the trip offer on arrival from the dashboard, above a form that still works', async () => {
    const user = userEvent.setup();
    const { created } = stub();
    renderCard(true);

    const offer = await screen.findByTestId('going-away-offer');
    expect(offer).toHaveAttribute('data-reason', 'entry');
    expect(within(offer).getByRole('heading', { name: 'Going away?' })).toBeVisible();

    await screen.findByText(/up to 7 days on your plan/i);
    await user.click(screen.getByRole('button', { name: /create sitter link/i }));
    expect(await screen.findByText('Your sitter link is ready')).toBeVisible();
    expect(created).toHaveLength(1);
  });

  it('asks an admin for a member instead of showing a purchase button', async () => {
    const user = userEvent.setup();
    stub({ role: 'member' });
    renderCard();

    await typeLength(user, '14');
    const offer = await screen.findByTestId('going-away-offer');
    expect(
      await within(offer).findByRole('button', { name: 'Ask Maria to upgrade' })
    ).toBeVisible();
    expect(within(offer).queryByRole('link', { name: /upgrade to garden/i })).toBeNull();
  });

  it('says "Get Garden back" to a household whose no-card trial has ended', async () => {
    const user = userEvent.setup();
    stub({ noCardTrial: { state: 'ended', endsAt: iso(-2 * DAY) } });
    renderCard();

    await typeLength(user, '14');
    const offer = await screen.findByTestId('going-away-offer');
    expect(
      within(offer).getByRole('link', { name: 'Get Garden back for $4.99 a month' })
    ).toBeVisible();
  });

  it('shows no price and no purchase button inside the apps', async () => {
    const user = userEvent.setup();
    (window as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
    };
    stub();
    renderCard();

    await typeLength(user, '14');
    const offer = await screen.findByTestId('going-away-offer');
    expect(within(offer).queryByText(/\$4\.99/)).toBeNull();
    expect(within(offer).queryByRole('link')).toBeNull();
    expect(within(offer).getByText(/plan changes aren't available in the app/i)).toBeVisible();
    // The free path is still offered.
    expect(within(offer).getByRole('button', { name: 'Use 7 days instead' })).toBeVisible();
  });
});

describe('Going away? negative controls', () => {
  it('offers nothing to a Garden household, even past its own cap', async () => {
    const user = userEvent.setup();
    stub({ planId: 'garden' });
    renderCard(true);

    // The control applied: the card read Garden's cap and took the typing.
    expect(await screen.findByText(/up to 90 days on your plan/i)).toBeVisible();
    const input = await typeLength(user, '120');
    expect(input).toHaveValue(120);
    expect(screen.queryByTestId('going-away-offer')).toBeNull();
  });

  it('offers nothing to a household on the running no-card trial', async () => {
    const user = userEvent.setup();
    stub({ noCardTrial: { state: 'active', endsAt: iso(5 * DAY) } });
    renderCard(true);

    expect(await screen.findByText(/up to 90 days on your plan/i)).toBeVisible();
    await typeLength(user, '30');
    expect(screen.queryByTestId('going-away-offer')).toBeNull();
  });

  it('claims nothing when the plan catalog could not be read', async () => {
    const user = userEvent.setup();
    const { plansRequests } = stub({ plansStatus: 500 });
    renderCard(true);

    await typeLength(user, '14');
    // The control applied: the catalog was asked for and refused.
    await waitFor(() => expect(plansRequests).toContain(500));
    expect(screen.queryByTestId('going-away-offer')).toBeNull();
  });

  it('shows nothing on the form without a trigger', async () => {
    stub();
    renderCard(false);

    expect(await screen.findByText(/up to 7 days on your plan/i)).toBeVisible();
    // The plain seedling hint is what a free household sees instead.
    expect(screen.getByText(/longer trip\? garden allows/i)).toBeVisible();
    expect(screen.queryByTestId('going-away-offer')).toBeNull();
  });
});

describe('GoingAwaySoonCard', () => {
  function renderSoon() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/dashboard']}>
          <Routes>
            <Route path="/dashboard" element={<GoingAwaySoonCard />} />
            <Route path="/household" element={<h1>Household page</h1>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
  }

  it('leads to the sitter-link form, on every plan, naming no price', async () => {
    const user = userEvent.setup();
    stub({ planId: 'garden' });
    renderSoon();

    const link = await screen.findByRole('link', { name: 'Set up a sitter link' });
    expect(screen.getByRole('heading', { name: 'Going away soon?' })).toBeVisible();
    expect(link).toHaveAttribute('href', GOING_AWAY_ROUTE);
    expect(screen.queryByText(/\$/)).toBeNull();
    await user.click(link);
    expect(await screen.findByRole('heading', { name: 'Household page' })).toBeVisible();
  });

  it('stays hidden while a sitter link is live', async () => {
    stub({ links: [LIVE_LINK] });
    let served = 0;
    server.use(
      http.get(`${API}/households/hh-1/sitter-links`, () => {
        served += 1;
        return HttpResponse.json([LIVE_LINK]);
      })
    );
    renderSoon();
    // The control applied: the live link was actually read before the
    // absence below is trusted.
    await waitFor(() => expect(served).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('heading', { name: 'Going away soon?' })).toBeNull();
  });

  it('hides for 30 days on "Not now", on this device only', async () => {
    const user = userEvent.setup();
    stub();
    renderSoon();

    await user.click(await screen.findByRole('button', { name: /hide the going-away card/i }));
    expect(screen.queryByRole('heading', { name: 'Going away soon?' })).toBeNull();
    const until = Date.parse(usePrefsStore.getState().goingAwayDismissedUntil['hh-1']);
    expect((until - Date.now()) / DAY).toBeGreaterThan(29.9);
  });
});
