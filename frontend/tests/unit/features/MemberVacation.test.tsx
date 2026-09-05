/**
 * Regression test for the vacation-window date bug: start/end dates picked
 * in a `<input type="date">` must resolve to LOCAL midnight / local
 * 23:59:59.999, not hardcoded UTC midnight (which drifts by the caller's
 * UTC offset). The assertions decode the ISO strings back with `new Date`
 * and read local hour/minute/second — timezone-agnostic, since both the
 * construction and the decode happen in the same process clock (pinned to
 * America/New_York by frontend/vitest.config.ts, a non-UTC offset, so a
 * regression to hardcoded `Z` strings would fail this test).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { http, HttpResponse } from 'msw';
import { MemberVacation } from '@/features/household/MemberVacation';
import { taskService } from '@/services/taskService';
import { useAuthStore } from '@/store/authStore';
import type { HouseholdMember } from '@/services/householdService';
import { server } from '../../msw/server';

vi.mock('@/services/taskService', () => ({
  taskService: {
    setVacation: vi.fn(),
    getVacationWindows: vi.fn(),
    cancelVacation: vi.fn(),
  },
}));

const setVacation = vi.mocked(taskService.setVacation);

const member: HouseholdMember = {
  userId: 'user-1',
  name: 'Alice',
  role: 'member',
  joinedAt: '',
};
const cover: HouseholdMember = {
  userId: 'user-2',
  name: 'Bob',
  role: 'member',
  joinedAt: '',
};

function renderForm() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <MemberVacation
          householdId="hh-1"
          member={member}
          members={[member, cover]}
          canManage
          window={undefined}
        />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('MemberVacation date window', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setVacation.mockResolvedValue({
      householdId: 'hh-1',
      userId: 'user-1',
      coveredBy: 'user-2',
      coveredByName: 'Bob',
      startDate: '',
      endDate: '',
      createdBy: 'user-1',
      createdAt: '',
    });
  });

  it('submits a window spanning local midnight-to-midnight, not fixed UTC midnight', async () => {
    renderForm();

    fireEvent.click(screen.getByText('Set vacation'));
    fireEvent.change(screen.getByLabelText('Start date'), {
      target: { value: '2026-07-10' },
    });
    fireEvent.change(screen.getByLabelText('End date'), {
      target: { value: '2026-07-12' },
    });
    fireEvent.click(screen.getByText('Save vacation'));

    await waitFor(() => expect(setVacation).toHaveBeenCalledTimes(1));
    const { startDate, endDate } = setVacation.mock.calls[0][0];

    const start = new Date(startDate);
    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(6); // July, 0-indexed
    expect(start.getDate()).toBe(10);
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    expect(start.getSeconds()).toBe(0);
    expect(start.getMilliseconds()).toBe(0);

    const end = new Date(endDate);
    expect(end.getFullYear()).toBe(2026);
    expect(end.getMonth()).toBe(6);
    expect(end.getDate()).toBe(12);
    expect(end.getHours()).toBe(23);
    expect(end.getMinutes()).toBe(59);
    expect(end.getSeconds()).toBe(59);
    expect(end.getMilliseconds()).toBe(999);

    // The old bug hardcoded a "Z" (UTC) suffix; assert it's gone in favor of
    // an offset that reflects the local (America/New_York) timezone.
    expect(startDate).not.toMatch(/T00:00:00\.000Z$/);
    expect(endDate).not.toMatch(/T23:59:59\.000Z$/);
  });
});

/**
 * The wiring #480 asks for: the vacation form is where a trip is declared,
 * and it never mentioned sitter links. These assert that the offer is
 * actually mounted in that form and reads the dates as they are typed — the
 * placement, not the copy, which `TripSitterOffer.test.tsx` covers.
 */
describe('MemberVacation sitter offer', () => {
  const API = 'http://localhost:4000';

  beforeEach(() => {
    useAuthStore.setState({
      accessToken: 'access-1',
      user: {
        id: 'user-1',
        email: 'me@example.com',
        name: 'Alice',
        householdId: 'hh-1',
        householdRole: 'member',
      },
      activeHouseholdId: 'hh-1',
    });
    server.use(
      http.get(`${API}/billing/plans`, () =>
        HttpResponse.json({
          paymentsAvailable: true,
          commercialHold: { active: false, effectiveDate: '2026-09-01' },
          plans: [
            {
              id: 'seedling',
              name: 'Seedling',
              description: '',
              maxPlants: 20,
              maxMembers: 3,
              limits: {
                homes: 1,
                members: 3,
                plants: 20,
                tags: 0,
                analyticsHistoryDays: 30,
                sitterLinkMaxDays: 7,
                sitterLinksActive: 1,
              },
              features: {
                awayKit: false,
                householdToolkit: false,
                plantTags: false,
                crossHomeToday: false,
                kiosk: false,
                caretakerSeats: false,
                moveDay: false,
                chat: false,
                apiKeys: false,
              },
            },
            {
              id: 'garden',
              name: 'Garden',
              description: '',
              maxPlants: 200,
              maxMembers: null,
              monthlyPrice: 4.99,
            },
          ],
        })
      ),
      http.get(`${API}/billing/me`, () => HttpResponse.json({ planId: 'seedling' })),
      http.get(`${API}/me/households`, () =>
        HttpResponse.json([{ householdId: 'hh-1', name: 'Home', role: 'member', joinedAt: '' }])
      ),
      http.get(`${API}/households/hh-1`, () =>
        HttpResponse.json({
          id: 'hh-1',
          name: 'Home',
          createdAt: '',
          createdBy: 'user-2',
          members: [
            { userId: 'user-2', name: 'Bob', role: 'admin', joinedAt: '' },
            { userId: 'user-1', name: 'Alice', role: 'member', joinedAt: '' },
          ],
        })
      )
    );
  });

  it('offers a sitter link the moment a trip longer than the free window is typed', async () => {
    renderForm();
    fireEvent.click(screen.getByText('Set vacation'));

    // Before the dates are complete the form says nothing about sitters: an
    // empty window is not a trip.
    expect(screen.queryByRole('link', { name: 'Set up a sitter link' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-06-03' } });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-06-24' } });

    expect(
      await screen.findByText(/That’s 22 days away, and one sitter link on your plan covers 7 days/)
    ).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Ask Bob to upgrade/ })).toBeInTheDocument();
  });
});
