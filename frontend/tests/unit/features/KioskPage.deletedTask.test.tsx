/**
 * Audit 2026-11-08, finding 9: a deleted task made a live wall display read
 * as turned off.
 *
 * `POST /kiosk/{token}/tasks/{taskId}/complete` answers 404 for a revoked
 * link and also for a task that someone deleted a moment ago. The client
 * mapped every 404 to "the link is inactive", and the page then stopped
 * polling for good, so one tap on a just-deleted task left a kitchen tablet
 * saying "This display has been turned off" until somebody reloaded it.
 *
 * These run the page against the real `kioskService` over a stubbed `fetch`,
 * because the defect lived in how the two fit together: with the service
 * mocked, the page test decides what a 404 means and proves nothing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { KioskPage } from '@/features/kiosk/KioskPage';
import type { KioskTask } from '@/services/kioskService';

const TOKEN = 'a'.repeat(64);
const POLL_SECONDS = 300;

function task(taskId: string, plantName: string): KioskTask {
  return {
    taskId,
    plantName,
    taskType: 'water',
    dueDate: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    spaceName: null,
    placementNote: null,
    overdue: true,
  };
}

const monstera = task('t1', 'Monstera');
const fern = task('t2', 'Fern');

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const LINK_OFF = json.bind(null, 404, {
  message: 'This kiosk link is invalid or has been turned off.',
});
const TASK_GONE = json.bind(null, 404, { message: 'Task not found' });

/**
 * Serve the kiosk API. `reads` answers each GET of the view in turn (the last
 * entry repeats), `completion` answers every POST.
 */
function serveKiosk(reads: Array<() => Response>, completion: () => Response) {
  const calls = { reads: 0, completions: 0 };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes(`/kiosk/${TOKEN}`)) throw new Error(`unexpected request: ${url}`);
      if (init?.method === 'POST') {
        calls.completions += 1;
        return completion();
      }
      const respond = reads[Math.min(calls.reads, reads.length - 1)];
      calls.reads += 1;
      return respond();
    })
  );
  return calls;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/kiosk/${TOKEN}`]}>
      <Routes>
        <Route path="/kiosk/:token" element={<KioskPage />} />
      </Routes>
    </MemoryRouter>
  );
}

const view = (tasks: KioskTask[]) => () => json(200, { pollIntervalSeconds: POLL_SECONDS, tasks });

function doneButtonFor(plantName: string): HTMLElement {
  const row = screen.getByText(new RegExp(plantName)).closest('li');
  if (!row) throw new Error(`no row for ${plantName}`);
  const button = row.querySelector('button');
  if (!button) throw new Error(`no Done button for ${plantName}`);
  return button;
}

describe('KioskPage, Done on a task someone just deleted', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps the display on, drops the deleted task and keeps polling', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = serveKiosk([view([monstera, fern]), view([fern])], TASK_GONE);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage();

    await screen.findByText(/Monstera/);
    await user.click(doneButtonFor('Monstera'));

    // The link's own read is what says whether the display is still on: it
    // answered, so the board shows what the household's list now holds.
    await waitFor(() => expect(screen.queryByText(/Monstera/)).not.toBeInTheDocument());
    expect(screen.getByText(/Fern/)).toBeInTheDocument();
    expect(screen.queryByText(/This display has been turned off/i)).not.toBeInTheDocument();
    expect(calls.completions).toBe(1);
    expect(calls.reads).toBe(2);

    // And the display is still alive: the next poll goes out.
    await vi.advanceTimersByTimeAsync(POLL_SECONDS * 1000 + 10);
    await waitFor(() => expect(calls.reads).toBe(3));
    expect(screen.getByText(/Fern/)).toBeInTheDocument();
  });

  it('reads as turned off when the link itself is reported inactive, and stops polling', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Revoked mid-session: the completion and the link's own read both 404.
    const calls = serveKiosk([view([monstera, fern]), LINK_OFF], LINK_OFF);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage();

    await screen.findByText(/Monstera/);
    await user.click(doneButtonFor('Monstera'));

    expect(await screen.findByText(/This display has been turned off/i)).toBeInTheDocument();
    expect(screen.queryByText(/Fern/)).not.toBeInTheDocument();
    const readsWhenRevoked = calls.reads;
    expect(readsWhenRevoked).toBe(2);

    // A revoked display must not keep billing the household for polls.
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(calls.reads).toBe(readsWhenRevoked);
  });

  it('keeps the last list, marked stale, when the link cannot be read after the 404', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = serveKiosk(
      [view([monstera, fern]), () => json(503, { message: 'Service Unavailable' })],
      TASK_GONE
    );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage();

    await screen.findByText(/Monstera/);
    await user.click(doneButtonFor('Monstera'));

    // Not known to be off, and not known to be done: say the list is old.
    expect(await screen.findByText(/Couldn’t refresh/i)).toBeInTheDocument();
    expect(screen.getByText(/Monstera/)).toBeInTheDocument();
    expect(screen.getByText(/Fern/)).toBeInTheDocument();
    expect(screen.queryByText(/This display has been turned off/i)).not.toBeInTheDocument();

    const readsBefore = calls.reads;
    await vi.advanceTimersByTimeAsync(POLL_SECONDS * 1000 + 10);
    await waitFor(() => expect(calls.reads).toBeGreaterThan(readsBefore));
  });
});
