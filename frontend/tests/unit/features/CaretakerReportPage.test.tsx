import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { CaretakerReportPage } from '@/features/caretaker/CaretakerReportPage';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

vi.mock('@/hooks/useActiveHousehold', () => ({
  useActiveHousehold: () => ({ householdId: 'hh-1', householdQuery: {} }),
}));

/**
 * This page is handed to someone who is paying for the visits, so the one
 * failure it must never have is rendering a confident, empty report when the
 * read failed. "No caretaker visits were recorded" and "we could not read the
 * records" are opposite claims, and only one of them is ever true.
 */
function renderPage(body: unknown | 'fail') {
  server.use(
    http.get(`${API}/households/hh-1/caretaker-report`, () =>
      body === 'fail' ? new HttpResponse(null, { status: 500 }) : HttpResponse.json(body)
    )
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <CaretakerReportPage />
    </QueryClientProvider>
  );
}

const emptyReport = {
  householdId: 'hh-1',
  from: '2026-08-04T00:00:00.000Z',
  to: '2026-09-03T23:59:59.999Z',
  generatedAt: '2026-09-03T12:00:00.000Z',
  visits: [],
  totals: { visits: 0, tasksCompleted: 0, photos: 0, notes: 0, caretakers: 0 },
  byCaretaker: [],
};

const oneVisit = {
  ...emptyReport,
  visits: [
    {
      id: 'v1',
      caretakerId: 's1',
      caretakerName: 'Dana',
      startedAt: '2026-09-01T09:00:00.000Z',
      lastActionAt: '2026-09-01T09:40:00.000Z',
      tasksCompleted: [
        {
          taskId: 't1',
          plantId: 'p1',
          plantName: 'Monstera',
          taskType: 'water',
          at: '2026-09-01T09:05:00.000Z',
        },
      ],
      photos: [],
      notes: [{ text: 'All watered.', at: '2026-09-01T09:40:00.000Z' }],
      taskCount: 120,
      photoCount: 0,
      noteCount: 1,
      omitted: { tasks: 119, photos: 0, notes: 0 },
      detailTruncated: true,
    },
  ],
  totals: { visits: 1, tasksCompleted: 120, photos: 0, notes: 1, caretakers: 1 },
  byCaretaker: [
    {
      caretakerId: 's1',
      caretakerName: 'Dana',
      visits: 1,
      tasksCompleted: 120,
      photos: 0,
      notes: 1,
      firstVisitAt: '2026-09-01T09:00:00.000Z',
      lastVisitAt: '2026-09-01T09:40:00.000Z',
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CaretakerReportPage', () => {
  it('says the records could not be read instead of showing an empty report', async () => {
    renderPage('fail');

    expect(await screen.findByText('We couldn’t load the visit records')).toBeInTheDocument();
    expect(
      screen.queryByText('No caretaker visits were recorded in this range.')
    ).not.toBeInTheDocument();
    // No totals either: a zero here would be a number nobody computed.
    expect(screen.queryByText('Tasks completed')).not.toBeInTheDocument();
  });

  it('says "no visits" only when the read actually succeeded and was empty', async () => {
    renderPage(emptyReport);

    expect(
      await screen.findByText('No caretaker visits were recorded in this range.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders the visit with its caretaker name and arrival time', async () => {
    renderPage(oneVisit);

    expect(await screen.findByText(/Dana — arrived/)).toBeInTheDocument();
    expect(
      screen.getByText('Arrival is the timestamp of their first action, not something they typed.')
    ).toBeInTheDocument();
    expect(screen.getByText(/water — Monstera/)).toBeInTheDocument();
    expect(screen.getByText(/All watered\./)).toBeInTheDocument();
  });

  it('reports the exact count and names the detail it could not store', async () => {
    renderPage(oneVisit);

    // 120 is the counter; only one line was stored. The report shows both
    // rather than quietly presenting "1".
    expect(await screen.findByText('120')).toBeInTheDocument();
    expect(
      screen.getByText(/119 tasks, 0 photos and 0 notes are counted above/)
    ).toBeInTheDocument();
  });
});
