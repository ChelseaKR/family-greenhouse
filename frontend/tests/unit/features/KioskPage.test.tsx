import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { KioskPage } from '@/features/kiosk/KioskPage';
import {
  kioskService,
  KioskLinkInactiveError,
  type KioskTask,
  type KioskView,
} from '@/services/kioskService';

vi.mock('@/services/kioskService', async () => {
  const actual =
    await vi.importActual<typeof import('@/services/kioskService')>('@/services/kioskService');
  return {
    ...actual,
    kioskService: { getView: vi.fn(), completeTask: vi.fn() },
  };
});

const getView = vi.mocked(kioskService.getView);
const completeTask = vi.mocked(kioskService.completeTask);

const TOKEN = 'a'.repeat(64);

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/kiosk/${TOKEN}`]}>
      <Routes>
        <Route path="/kiosk/:token" element={<KioskPage />} />
        <Route path="/" element={<div>Home</div>} />
      </Routes>
    </MemoryRouter>
  );
}

const waterTask: KioskTask = {
  taskId: 't1',
  plantName: 'Monstera',
  taskType: 'water',
  dueDate: new Date(Date.now() - 1000).toISOString(),
  spaceName: 'Kitchen',
  placementNote: 'by the sink',
  overdue: true,
};

const view: KioskView = { pollIntervalSeconds: 300, tasks: [waterTask] };

describe('KioskPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows today’s tasks in large type with a Done button', async () => {
    getView.mockResolvedValue(view);
    renderPage();

    expect(await screen.findByText(/Monstera/)).toBeInTheDocument();
    expect(screen.getByText(/Kitchen · by the sink/)).toBeInTheDocument();
    expect(screen.getByText('Overdue')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
  });

  it('offers no navigation away from the display', async () => {
    getView.mockResolvedValue(view);
    renderPage();
    await screen.findByText(/Monstera/);
    // The token grants a task list and nothing else, so the page must not
    // hand a passer-by a door to anywhere — not even the marketing site.
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('tells anyone walking past what the screen is showing', async () => {
    getView.mockResolvedValue(view);
    renderPage();
    await screen.findByText(/Monstera/);
    expect(screen.getByText(/showing your household’s plant tasks/i)).toBeInTheDocument();
  });

  it('hints at the device sleep setting when no wake lock is available', async () => {
    getView.mockResolvedValue(view);
    renderPage();
    await screen.findByText(/Monstera/);
    // jsdom has no navigator.wakeLock, which is exactly the case the hint is
    // for: we could not keep the screen on, so tell the household how.
    expect(screen.getByText(/turn off the device’s sleep/i)).toBeInTheDocument();
  });

  it('says "couldn’t load" on a failed first read — never an empty all-done screen', async () => {
    getView.mockRejectedValue(new Error('network'));
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn’t load/i);
    // The defect this guards: a wall display showing nothing reads as "all
    // caught up" and nobody questions it.
    expect(screen.queryByText(/Nothing due right now/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument();
  });

  it('distinguishes a genuinely empty list from a failed one', async () => {
    getView.mockResolvedValue({ pollIntervalSeconds: 300, tasks: [] });
    renderPage();

    expect(await screen.findByText(/Nothing due right now/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a friendly screen when the link has been revoked', async () => {
    getView.mockRejectedValue(new KioskLinkInactiveError());
    renderPage();

    expect(await screen.findByText(/This display has been turned off/i)).toBeInTheDocument();
  });

  it('completes a task and drops it off the board', async () => {
    getView.mockResolvedValue(view);
    completeTask.mockResolvedValue({ ...waterTask, overdue: false });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Done' }));

    await waitFor(() => expect(screen.queryByText(/Monstera/)).not.toBeInTheDocument());
    expect(completeTask).toHaveBeenCalledWith(TOKEN, 't1', waterTask.dueDate);
  });

  it('falls back to the revoked screen if the link dies mid-tap', async () => {
    getView.mockResolvedValue(view);
    completeTask.mockRejectedValue(new KioskLinkInactiveError());
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Done' }));
    expect(await screen.findByText(/This display has been turned off/i)).toBeInTheDocument();
  });

  it('keeps the last good list and marks it stale when a refresh fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    getView.mockResolvedValueOnce(view).mockRejectedValue(new Error('network'));
    renderPage();

    expect(await screen.findByText(/Monstera/)).toBeInTheDocument();

    // Advance past one poll interval so the refresh runs and fails.
    await vi.advanceTimersByTimeAsync(300 * 1000 + 10);

    await waitFor(() => expect(screen.getByText(/Couldn’t refresh/i)).toBeInTheDocument());
    // Blanking the board on a failed refresh would read as "all done".
    expect(screen.getByText(/Monstera/)).toBeInTheDocument();
  });

  it('polls on the interval the server chose, not a hardcoded one', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    getView.mockResolvedValue({ ...view, pollIntervalSeconds: 900 });
    renderPage();

    await screen.findByText(/Monstera/);
    expect(getView).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(300 * 1000 + 10);
    expect(getView).toHaveBeenCalledTimes(1); // 5 minutes is not this display's interval

    await vi.advanceTimersByTimeAsync(600 * 1000);
    await waitFor(() => expect(getView).toHaveBeenCalledTimes(2));
  });

  it('stops polling once the link is revoked', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    getView.mockRejectedValue(new KioskLinkInactiveError());
    renderPage();

    await screen.findByText(/This display has been turned off/i);
    const callsAfterFirst = getView.mock.calls.length;

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    // A revoked display must not keep billing the household for polls.
    expect(getView).toHaveBeenCalledTimes(callsAfterFirst);
  });
});
