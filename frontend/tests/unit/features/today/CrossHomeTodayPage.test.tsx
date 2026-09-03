import { beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CrossHomeTodayPage } from '@/features/today/CrossHomeTodayPage';
import { useAuthStore, type User } from '@/store/authStore';
import { server } from '../../../msw/server';

const API = 'http://localhost:4000';

function atLocalNoon(offsetDays: number): string {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString();
}

function row(
  id: string,
  householdId: string,
  householdName: string,
  plantName: string,
  nextDue: string,
  extra: Record<string, unknown> = {}
) {
  return {
    id,
    householdId,
    householdName,
    plantId: `plant-${id}`,
    plantName,
    type: 'water',
    customType: null,
    frequency: 7,
    lastCompleted: null,
    nextDue,
    assignedTo: null,
    assignedToName: null,
    assignmentSource: null,
    notes: null,
    createdBy: 'u1',
    createdAt: '',
    ...extra,
  };
}

const FIXTURE = {
  generatedAt: new Date().toISOString(),
  cutoff: atLocalNoon(0),
  households: [
    {
      householdId: 'hh-home',
      name: 'Home',
      role: 'admin',
      status: 'ok',
      tasks: [row('t-home', 'hh-home', 'Home', 'Monstera', atLocalNoon(0))],
    },
    {
      householdId: 'hh-beach',
      name: 'Beach Cottage',
      role: 'member',
      status: 'ok',
      tasks: [row('t-beach', 'hh-beach', 'Beach Cottage', 'Fern', atLocalNoon(-2))],
    },
    { householdId: 'hh-rental', name: 'The Rental', role: 'member', status: 'ok', tasks: [] },
    { householdId: 'hh-moms', name: "Mom's", role: 'member', status: 'unavailable' },
  ],
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/today']}>
        <CrossHomeTodayPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  // The caller's ACTIVE household is their own home; rows from other homes
  // must still act on their own household, not this one.
  useAuthStore.setState({
    accessToken: 'access-1',
    activeHouseholdId: 'hh-home',
    user: { id: 'u1', email: 'me@example.com', name: 'Me', householdId: 'hh-home' } as User,
  });
});

describe('CrossHomeTodayPage', () => {
  it('renders one section per home, labels every row with its home, and never merges', async () => {
    server.use(http.get(`${API}/me/today`, () => HttpResponse.json(FIXTURE)));
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Beach Cottage' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'The Rental' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: "Mom's" })).toBeInTheDocument();

    // The home is on the row itself, not only on the section.
    expect(screen.getByText('In Home')).toBeInTheDocument();
    expect(screen.getByText('In Beach Cottage')).toBeInTheDocument();

    // Per-household role, from that household's membership.
    expect(screen.getAllByText('admin')).toHaveLength(1);
    expect(screen.getAllByText('member')).toHaveLength(3);

    // Overdue vs due today is stated per row.
    expect(screen.getByText('Overdue')).toBeInTheDocument();
    expect(screen.getByText('Due today')).toBeInTheDocument();
  });

  it('says "nothing due" in a home’s own words and renders an unreachable home as unavailable, not empty', async () => {
    server.use(http.get(`${API}/me/today`, () => HttpResponse.json(FIXTURE)));
    renderPage();

    expect(await screen.findByText('Nothing due today at The Rental.')).toBeInTheDocument();
    expect(screen.getByText("We couldn't reach this home")).toBeInTheDocument();
    expect(screen.getByText(/Mom's didn't answer just now/)).toBeInTheDocument();
    // The unreachable home is NOT described as having nothing due.
    expect(screen.queryByText("Nothing due today at Mom's.")).not.toBeInTheDocument();
  });

  it('shows the homes-and-hands explanation on a 402 — on this URL, not a 404 and not an empty list', async () => {
    server.use(
      http.get(`${API}/me/today`, () =>
        HttpResponse.json(
          { message: 'Today across your homes is included with the Greenhouse plan.' },
          { status: 402 }
        )
      )
    );
    renderPage();

    expect(await screen.findByText('Included with Greenhouse')).toBeInTheDocument();
    expect(screen.getByText(/many homes and many hands/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View plan status' })).toHaveAttribute(
      'href',
      '/settings/billing'
    );
    expect(screen.queryByText(/Nothing due today/)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toHaveTextContent(/unexpected error/i);
  });

  it('surfaces any other failure as an error with a retry, never as an empty queue', async () => {
    server.use(
      http.get(`${API}/me/today`, () =>
        HttpResponse.json({ message: 'DynamoDB is having a day' }, { status: 500 })
      )
    );
    renderPage();

    // One automatic retry (≈1s backoff) precedes the settled error state.
    expect(await screen.findByRole('alert', {}, { timeout: 4000 })).toHaveTextContent(
      'DynamoDB is having a day'
    );
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByText(/Nothing due today/)).not.toBeInTheDocument();
  });

  it("completes a row in ITS home: X-Household-Id is the row's household, not the active one", async () => {
    let capturedHousehold: string | null = null;
    let capturedBody: unknown = null;
    server.use(
      http.get(`${API}/me/today`, () => HttpResponse.json(FIXTURE)),
      http.post(`${API}/tasks/t-beach/complete`, async ({ request }) => {
        capturedHousehold = request.headers.get('x-household-id');
        capturedBody = await request.json();
        return HttpResponse.json({
          ...FIXTURE.households[1].tasks[0],
          lastCompleted: new Date().toISOString(),
          nextDue: atLocalNoon(7),
        });
      })
    );
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Mark Fern done at Beach Cottage' }));

    await waitFor(() => expect(capturedHousehold).toBe('hh-beach'));
    expect(capturedBody).toEqual({ expectedNextDue: atLocalNoon(-2) });
    // Done leaves the queue; the other homes are untouched.
    await waitFor(() => expect(screen.queryByText('Fern')).not.toBeInTheDocument());
    expect(screen.getByText('Monstera')).toBeInTheDocument();
  });

  it("claims a row in ITS home and shows the server's answer on the row", async () => {
    let capturedHousehold: string | null = null;
    server.use(
      http.get(`${API}/me/today`, () => HttpResponse.json(FIXTURE)),
      http.post(`${API}/tasks/t-beach/claim`, ({ request }) => {
        capturedHousehold = request.headers.get('x-household-id');
        return HttpResponse.json({
          ...FIXTURE.households[1].tasks[0],
          assignedTo: 'u1',
          assignedToName: 'Me',
        });
      })
    );
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Claim the Fern task' }));

    await waitFor(() => expect(capturedHousehold).toBe('hh-beach'));
    expect(await screen.findByText('Assigned to Me')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unclaim the Fern task' })).toBeInTheDocument();
    // Still labelled with its home after the patch.
    expect(screen.getByText('In Beach Cottage')).toBeInTheDocument();
  });
});
