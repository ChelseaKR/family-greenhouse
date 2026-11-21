import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { CaretakerReportPage } from '@/features/caretaker/CaretakerReportPage';
import { server } from '../../msw/server';
import { toEndOfDayIso, toStartOfDayIso } from '@/features/household/localDates';

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

  it('asks for the picked days in local time, not as UTC days', async () => {
    // The server reads a bare YYYY-MM-DD as a UTC day. In this suite's zone
    // (America/New_York) that window ended at 7pm on the "to" day and the
    // heading named the day before "from". The page now sends the local
    // day's own bounds, so the window and the heading are the days picked.
    const asked: URLSearchParams[] = [];
    server.use(
      http.get(`${API}/households/hh-1/caretaker-report`, ({ request }) => {
        const params = new URL(request.url).searchParams;
        asked.push(params);
        return HttpResponse.json({
          ...emptyReport,
          from: params.get('from'),
          to: params.get('to'),
        });
      })
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <CaretakerReportPage />
      </QueryClientProvider>
    );
    await screen.findByText('No caretaker visits were recorded in this range.');

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-09-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-09-03' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show this range' }));

    await waitFor(() => expect(asked).toHaveLength(2));
    expect(asked[1].get('from')).toBe(toStartOfDayIso('2026-09-01'));
    expect(asked[1].get('to')).toBe(toEndOfDayIso('2026-09-03'));
    expect(await screen.findByText(/Sep 1, 2026 to Sep 3, 2026/)).toBeInTheDocument();
  });

  it('leaves a cleared date to the server default instead of failing', async () => {
    const asked: URLSearchParams[] = [];
    server.use(
      http.get(`${API}/households/hh-1/caretaker-report`, ({ request }) => {
        asked.push(new URL(request.url).searchParams);
        return HttpResponse.json(emptyReport);
      })
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <CaretakerReportPage />
      </QueryClientProvider>
    );
    await screen.findByText('No caretaker visits were recorded in this range.');

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show this range' }));

    await waitFor(() => expect(asked).toHaveLength(2));
    expect(asked[1].has('from')).toBe(false);
    expect(asked[1].get('to')).not.toBeNull();
    expect(screen.queryByText('We couldn’t load the visit records')).not.toBeInTheDocument();
  });
});
