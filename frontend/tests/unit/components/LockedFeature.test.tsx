import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { http, HttpResponse } from 'msw';
import { AskToUpgrade, LockedFeature } from '@/components/LockedFeature';
import { formatNameList } from '@/utils/nameList';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

const PLANS = [
  { id: 'seedling', name: 'Seedling', description: '', maxPlants: 10, maxMembers: 6 },
  {
    id: 'garden',
    name: 'Garden',
    description: '',
    maxPlants: 500,
    maxMembers: 6,
    monthlyPrice: 4.99,
  },
  {
    id: 'greenhouse',
    name: 'Greenhouse',
    description: '',
    maxPlants: 5000,
    maxMembers: 50,
    monthlyPrice: 9.99,
  },
];

function roster(members: Array<{ userId: string; name: string; role: 'admin' | 'member' }>) {
  return {
    id: 'hh-1',
    name: 'Home',
    createdAt: '',
    createdBy: 'u-admin',
    members: members.map((m) => ({ ...m, joinedAt: '' })),
  };
}

function signIn(role: 'admin' | 'member') {
  useAuthStore.setState({
    accessToken: 'access-1',
    user: {
      id: 'u-me',
      email: 'me@example.com',
      name: 'Sam',
      householdId: 'hh-1',
      householdRole: role,
    },
    activeHouseholdId: 'hh-1',
  });
  server.use(
    http.get(`${API}/me/households`, () =>
      HttpResponse.json([{ householdId: 'hh-1', name: 'Home', role, joinedAt: '' }])
    )
  );
}

function stubReads({
  paymentsAvailable = true,
  planId = 'seedling',
  members = [
    { userId: 'u-admin', name: 'Maria', role: 'admin' as const },
    { userId: 'u-me', name: 'Sam', role: 'member' as const },
  ],
} = {}) {
  server.use(
    http.get(`${API}/billing/plans`, () =>
      HttpResponse.json({
        paymentsAvailable,
        commercialHold: { active: false, effectiveDate: '2026-09-01' },
        plans: PLANS,
      })
    ),
    http.get(`${API}/billing/me`, () => HttpResponse.json({ planId })),
    http.get(`${API}/households/hh-1`, () => HttpResponse.json(roster(members)))
  );
}

function renderLocked(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('formatNameList', () => {
  it('joins names the way the locale reads them', () => {
    expect(formatNameList(['Maria'], 'en')).toBe('Maria');
    expect(formatNameList(['Maria', 'Tom'], 'en')).toBe('Maria and Tom');
    expect(formatNameList(['Maria', 'Tom', 'Sam'], 'en')).toBe('Maria, Tom, and Sam');
    expect(formatNameList(['Maria', 'Tom'], 'es')).toBe('Maria y Tom');
    expect(formatNameList([], 'en')).toBe('');
  });
});

describe('LockedFeature', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the feature LOCKED for a member: what it is, which plan includes it, and a one-tap ask naming the admin', async () => {
    signIn('member');
    stubReads();
    renderLocked(
      <LockedFeature feature="chat">Ask about your plants in plain language.</LockedFeature>
    );

    expect(await screen.findByRole('heading', { name: 'Plant care chat' })).toBeInTheDocument();
    expect(screen.getByText('Ask about your plants in plain language.')).toBeInTheDocument();
    expect(await screen.findByTestId('locked-included')).toHaveTextContent(
      'Included with Garden — $4.99 a month for the whole household'
    );
    expect(await screen.findByRole('button', { name: 'Ask Maria to upgrade' })).toBeEnabled();
    expect(screen.queryByRole('link', { name: 'Change plan' })).not.toBeInTheDocument();
  });

  it('names every admin when the household has more than one', async () => {
    signIn('member');
    stubReads({
      members: [
        { userId: 'u-admin', name: 'Maria', role: 'admin' },
        { userId: 'u-admin-2', name: 'Tom', role: 'admin' },
        { userId: 'u-me', name: 'Sam', role: 'member' },
      ],
    });
    renderLocked(<LockedFeature feature="api_keys" />);

    expect(
      await screen.findByRole('button', { name: 'Ask Maria and Tom to upgrade' })
    ).toBeInTheDocument();
    expect(await screen.findByTestId('locked-included')).toHaveTextContent(
      /Included with Greenhouse/
    );
  });

  it('sends the ask for THIS feature and reports who was told', async () => {
    signIn('member');
    stubReads();
    const bodies: unknown[] = [];
    server.use(
      http.post(`${API}/households/hh-1/upgrade-requests`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(
          {
            feature: 'chat',
            targetPlanId: 'garden',
            requestedAt: '2026-09-03T10:00:00.000Z',
            nextAllowedAt: '2026-09-10T10:00:00.000Z',
            admins: [{ userId: 'u-admin', name: 'Maria' }],
            emailDelivered: true,
            pushDelivered: false,
          },
          { status: 201 }
        );
      })
    );
    renderLocked(<LockedFeature feature="chat" />);

    await userEvent.click(await screen.findByRole('button', { name: 'Ask Maria to upgrade' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Sent. Maria will get a note in the app and by email.'
    );
    expect(bodies).toEqual([{ feature: 'chat' }]);
    expect(screen.queryByRole('button', { name: /upgrade/ })).not.toBeInTheDocument();
  });

  it('does not claim an email went out when the server says it did not', async () => {
    signIn('member');
    stubReads();
    server.use(
      http.post(`${API}/households/hh-1/upgrade-requests`, () =>
        HttpResponse.json(
          {
            feature: 'chat',
            targetPlanId: 'garden',
            requestedAt: '2026-09-03T10:00:00.000Z',
            nextAllowedAt: '2026-09-10T10:00:00.000Z',
            admins: [{ userId: 'u-admin', name: 'Maria' }],
            emailDelivered: false,
            pushDelivered: true,
          },
          { status: 201 }
        )
      )
    );
    renderLocked(<AskToUpgrade feature="chat" />);

    await userEvent.click(await screen.findByRole('button', { name: 'Ask Maria to upgrade' }));

    expect(await screen.findByRole('status')).toHaveTextContent(/the email could not be sent/);
  });

  it('shows when the member can ask again after the server rate-limits the repeat', async () => {
    signIn('member');
    stubReads();
    server.use(
      http.post(`${API}/households/hh-1/upgrade-requests`, () =>
        HttpResponse.json(
          {
            message: 'You already asked for this recently.',
            details: { nextAllowedAt: '2026-09-10T10:00:00.000Z' },
          },
          { status: 429 }
        )
      )
    );
    renderLocked(<AskToUpgrade feature="chat" />);

    await userEvent.click(await screen.findByRole('button', { name: 'Ask Maria to upgrade' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /You already asked about this\. You can ask again on Sep 10, 2026\./
    );
    // The button stays so a later week's ask is still one tap away.
    expect(screen.getByRole('button', { name: 'Ask Maria to upgrade' })).toBeInTheDocument();
  });

  it('gives an admin the change-plan link instead of an ask', async () => {
    signIn('admin');
    stubReads({
      members: [
        { userId: 'u-me', name: 'Sam', role: 'admin' },
        { userId: 'u-2', name: 'Maria', role: 'member' },
      ],
    });
    renderLocked(<LockedFeature feature="chat" />);

    expect(await screen.findByRole('link', { name: 'Change plan' })).toHaveAttribute(
      'href',
      '/settings/billing'
    );
    expect(screen.queryByRole('button', { name: /upgrade/ })).not.toBeInTheDocument();
  });

  it('offers no ask while the API says payments are paused', async () => {
    signIn('member');
    stubReads({ paymentsAvailable: false });
    renderLocked(<LockedFeature feature="chat" />);

    expect(await screen.findByText(/Paid plan changes are paused right now/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /upgrade/ })).not.toBeInTheDocument();
  });

  it('never guesses a name: a failed roster read asks "your household admin"', async () => {
    signIn('member');
    stubReads();
    server.use(
      http.get(`${API}/households/hh-1`, () =>
        HttpResponse.json({ message: 'boom' }, { status: 500 })
      )
    );
    renderLocked(<AskToUpgrade feature="chat" />);

    expect(
      await screen.findByRole('button', { name: 'Ask your household admin to upgrade' })
    ).toBeInTheDocument();
  });
});
