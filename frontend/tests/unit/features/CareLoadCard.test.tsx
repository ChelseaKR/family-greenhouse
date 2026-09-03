import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { CareLoadCard } from '@/features/household/CareLoadCard';
import type { HouseholdMember } from '@/services/householdService';
import { server } from '../../msw/server';

expect.extend(toHaveNoViolations);

declare module 'vitest' {
  interface Assertion {
    toHaveNoViolations(): void;
  }
}

const API = 'http://localhost:4000';
const DAY = 24 * 60 * 60 * 1000;

const members: HouseholdMember[] = [
  { userId: 'u1', name: 'Alice', role: 'admin', joinedAt: '' },
  { userId: 'u2', name: 'Bob', role: 'member', joinedAt: '' },
];

const completion = (actorId: string, actorName: string, daysAgo: number, id: string) => ({
  id,
  type: 'task.completed',
  householdId: 'hh-1',
  actorId,
  actorName,
  occurredAt: new Date(Date.now() - daysAgo * DAY).toISOString(),
  payload: { taskId: 't', plantId: 'p', taskType: 'water' },
});

const task = (id: string, assignedTo: string | null) => ({
  id,
  plantId: 'p',
  plantName: 'Monstera',
  type: 'water',
  frequency: 7,
  lastCompleted: null,
  nextDue: new Date(Date.now() + DAY).toISOString(),
  assignedTo,
  assignedToName: assignedTo,
  notes: null,
  createdBy: 'u1',
  createdAt: '',
});

function renderCard(activity: unknown[] | 'fail', tasks: unknown[] = []) {
  server.use(
    http.get(`${API}/households/hh-1/activity`, () =>
      activity === 'fail' ? new HttpResponse(null, { status: 500 }) : HttpResponse.json(activity)
    ),
    http.get(`${API}/tasks`, () => HttpResponse.json(tasks))
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <CareLoadCard householdId="hh-1" members={members} currentUserId="u1" />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('CareLoadCard', () => {
  it('shows what each person did and what they are holding', async () => {
    renderCard(
      [completion('u1', 'Alice', 1, 'a'), completion('u2', 'Bob', 2, 'b')],
      [task('t1', 'u1'), task('t2', 'u2')]
    );

    const alice = await screen.findByRole('row', { name: /Alice/ });
    expect(alice).toHaveTextContent('1');
    expect(alice).toHaveTextContent('50%');
    expect(screen.getByRole('row', { name: /Bob/ })).toHaveTextContent('50%');
  });

  it('names the pooled plant sitter rather than a link id', async () => {
    renderCard([completion('sitter:link-abc', 'a plant sitter', 1, 'a')]);

    expect(await screen.findByRole('row', { name: /Plant sitter/ })).toBeInTheDocument();
    expect(screen.queryByText(/link-abc/)).not.toBeInTheDocument();
  });

  it('points a lopsided split at the shared pool, not at the people who did less', async () => {
    const activity = [
      ...Array.from({ length: 8 }, (_, i) => completion('u1', 'Alice', i + 1, `a${i}`)),
      completion('u2', 'Bob', 1, 'b'),
    ];
    renderCard(activity, [task('t1', null), task('t2', null)]);

    expect(await screen.findByText(/Most of the care has landed on Alice/)).toBeInTheDocument();
    expect(screen.getByText('Up for grabs: 2')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /task list/i })).toHaveAttribute('href', '/tasks');
    // Nobody is told they are behind.
    expect(screen.queryByText(/Bob has/)).not.toBeInTheDocument();
  });

  it('stays quiet about the split when the work is shared evenly', async () => {
    const activity = [
      ...Array.from({ length: 4 }, (_, i) => completion('u1', 'Alice', i + 1, `a${i}`)),
      ...Array.from({ length: 4 }, (_, i) => completion('u2', 'Bob', i + 1, `b${i}`)),
    ];
    renderCard(activity, [task('t1', 'u1')]);

    expect(await screen.findByRole('row', { name: /Alice/ })).toBeInTheDocument();
    expect(screen.queryByText(/Most of the care has landed/)).not.toBeInTheDocument();
    expect(screen.getByText(/Every task has someone’s name on it/)).toBeInTheDocument();
  });

  it('says a failed read failed instead of showing a household that did nothing', async () => {
    // An empty split is the single worst thing this card could invent: it
    // reads as "nobody helped", which is exactly the argument the product is
    // trying to prevent.
    renderCard('fail');

    const alert = await screen.findByText(/couldn’t work out how care is shared/i);
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveTextContent(/nobody having done anything/i);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('renders the split as a table a screen reader can navigate', async () => {
    const { container } = renderCard(
      [completion('u1', 'Alice', 1, 'a')],
      [task('t1', 'u1'), task('t2', null)]
    );

    await screen.findByRole('row', { name: /Alice/ });
    // Column headers name the numbers; each person is a row header, so a
    // screen reader announces "Alice, Care done, 1" rather than a bare digit.
    expect(screen.getByRole('columnheader', { name: 'Care done' })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: 'Alice (you)' })).toBeInTheDocument();
    expect(
      await axe(container, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      })
    ).toHaveNoViolations();
  });

  it('says nothing has been logged yet without claiming a share of zero is a result', async () => {
    renderCard([], [task('t1', 'u1')]);

    expect(
      await screen.findByText(/No care has been logged in this period yet/)
    ).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /Alice/ })).toHaveTextContent('0%');
  });
});
