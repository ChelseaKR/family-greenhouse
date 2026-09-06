/**
 * The Away Kit offer at the moment of intent (#480).
 *
 * The offer used to fire only in `SitterLinksCard`, when someone typed a
 * window longer than seven days — the moment of failure, reachable only by
 * someone who already knew sitter links existed. These tests pin it to the
 * vacation form, where a dated trip is actually declared, and pin the two
 * things it must never do: claim a cap it did not read, and offer an upgrade
 * to a household that already has the feature.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { http, HttpResponse } from 'msw';
import { TripSitterOffer } from '@/features/household/TripSitterOffer';
import { tripLengthDays } from '@/features/household/localDates';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

const plan = (
  id: string,
  name: string,
  sitterLinkMaxDays: number | null,
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
    sitterLinksActive: 1,
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
  plan('seedling', 'Seedling', 7, false),
  plan('garden', 'Garden', 90, true, 4.99),
  plan('greenhouse', 'Greenhouse', 90, true, 9.99),
];

function stubReads({ planId = 'seedling', plansStatus = 200 } = {}) {
  server.use(
    http.get(`${API}/billing/plans`, () =>
      plansStatus === 200
        ? HttpResponse.json({
            paymentsAvailable: true,
            commercialHold: { active: false, effectiveDate: '2026-09-01' },
            plans: PLANS,
          })
        : HttpResponse.json({ message: 'nope' }, { status: plansStatus })
    ),
    http.get(`${API}/billing/me`, () => HttpResponse.json({ planId })),
    http.get(`${API}/me/households`, () =>
      HttpResponse.json([{ householdId: 'hh-1', name: 'Home', role: 'member', joinedAt: '' }])
    ),
    http.get(`${API}/households/hh-1`, () =>
      HttpResponse.json({
        id: 'hh-1',
        name: 'Home',
        createdAt: '',
        createdBy: 'u-admin',
        members: [
          { userId: 'u-admin', name: 'Maria', role: 'admin', joinedAt: '' },
          { userId: 'u-me', name: 'Sam', role: 'member', joinedAt: '' },
        ],
      })
    )
  );
}

function renderOffer(startDate: string, endDate: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <TripSitterOffer householdId="hh-1" startDate={startDate} endDate={endDate} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  useAuthStore.setState({
    accessToken: 'access-1',
    user: {
      id: 'u-me',
      email: 'me@example.com',
      name: 'Sam',
      householdId: 'hh-1',
      householdRole: 'member',
    },
    activeHouseholdId: 'hh-1',
  });
});

describe('tripLengthDays', () => {
  it('counts both ends of the window, because that is what a sitter link must cover', () => {
    // June 3rd to June 24th is 22 days of coverage, not 21: a link created for
    // 21 days expires at midnight on the 24th and leaves the last day open.
    expect(tripLengthDays('2026-06-03', '2026-06-24')).toBe(22);
    expect(tripLengthDays('2026-06-03', '2026-06-03')).toBe(1);
    expect(tripLengthDays('2026-06-03', '2026-06-09')).toBe(7);
  });

  it('says nothing rather than zero when the window is not a window yet', () => {
    expect(tripLengthDays('', '2026-06-24')).toBeNull();
    expect(tripLengthDays('2026-06-03', '')).toBeNull();
    expect(tripLengthDays('2026-06-24', '2026-06-03')).toBeNull();
    expect(tripLengthDays('not-a-date', '2026-06-24')).toBeNull();
  });
});

describe('TripSitterOffer', () => {
  it('says nothing at all until a whole trip has been typed', () => {
    // No dates, so no plan read either — nothing to say and nothing to spend.
    const { container } = renderOffer('2026-06-03', '');
    expect(container).toBeEmptyDOMElement();
  });

  it('points a free household at a sitter link, and says how long one covers', async () => {
    stubReads({ planId: 'seedling' });
    renderOffer('2026-06-03', '2026-06-24');

    expect(
      await screen.findByText(/That’s 22 days away, and one sitter link on your plan covers 7 days/)
    ).toBeInTheDocument();
    // The whole point: the vacation form now reaches the sitter-link form.
    expect(screen.getByRole('link', { name: 'Set up a sitter link' })).toHaveAttribute(
      'href',
      '#sitter-links'
    );
    // And the Away Kit is offered here, at the moment of intent, with the
    // price coming from the live catalog rather than from this component.
    expect(await screen.findByText(/The Away Kit — longer sitter links/)).toBeInTheDocument();
    expect(await screen.findByTestId('locked-included')).toHaveTextContent(/Garden/);
    expect(await screen.findByRole('button', { name: /Ask Maria to upgrade/ })).toBeEnabled();
  });

  it('mentions sitter links for a short trip too, without an upsell', async () => {
    stubReads({ planId: 'seedling' });
    renderOffer('2026-06-03', '2026-06-07');

    // Positive end state first, so the absences below are real absences.
    expect(
      await screen.findByText(/That’s 5 days away\. A plant-sitter link lets whoever is watering/)
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set up a sitter link' })).toBeInTheDocument();
    expect(screen.queryByText(/The Away Kit/)).not.toBeInTheDocument();
    expect(screen.queryByText(/covers 7 days/)).not.toBeInTheDocument();
  });

  it('never offers the Away Kit to a household that already has it', async () => {
    stubReads({ planId: 'garden' });
    renderOffer('2026-06-03', '2026-06-24');

    expect(
      await screen.findByText(/That’s 22 days away\. A plant-sitter link lets whoever is watering/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/The Away Kit/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /upgrade/i })).not.toBeInTheDocument();
  });

  it('tells a Garden household its own cap without offering it anything', async () => {
    stubReads({ planId: 'garden' });
    renderOffer('2026-01-01', '2026-06-24');

    expect(
      await screen.findByText(/one sitter link on your plan covers 90 days/)
    ).toBeInTheDocument();
    // Over the cap, but no higher tier lifts it — so no ask.
    expect(screen.queryByText(/The Away Kit/)).not.toBeInTheDocument();
  });

  it('claims no cap and offers nothing when the plan could not be read', async () => {
    stubReads({ planId: 'seedling', plansStatus: 500 });
    renderOffer('2026-06-03', '2026-06-24');

    // "we could not read your plan" is not "your plan covers 7 days", and it
    // is certainly not "you don't have the Away Kit" (ADR 0010).
    expect(
      await screen.findByText(/That’s 22 days away\. A plant-sitter link lets whoever is watering/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/covers 7 days/)).not.toBeInTheDocument();
    expect(screen.queryByText(/The Away Kit/)).not.toBeInTheDocument();
  });
});
