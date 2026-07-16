import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SitPage } from '@/features/sitter/SitPage';
import {
  sitterService,
  SitterLinkInactiveError,
  type SitterTask,
  type SitterView,
} from '@/services/sitterService';

vi.mock('@/services/sitterService', async () => {
  const actual = await vi.importActual<typeof import('@/services/sitterService')>(
    '@/services/sitterService'
  );
  return {
    ...actual,
    sitterService: { getView: vi.fn(), completeTask: vi.fn() },
  };
});

const getView = vi.mocked(sitterService.getView);
const completeTask = vi.mocked(sitterService.completeTask);

function renderPage(token = 'a'.repeat(64)) {
  return render(
    <MemoryRouter initialEntries={[`/sit/${token}`]}>
      <Routes>
        <Route path="/sit/:token" element={<SitPage />} />
        <Route path="/" element={<div>Home</div>} />
      </Routes>
    </MemoryRouter>
  );
}

const waterTask: SitterTask = {
  taskId: 't1',
  plantName: 'Monstera',
  taskType: 'water',
  dueDate: new Date(Date.now() - 1000).toISOString(),
  spaceName: 'Living Room',
  placementNote: 'east window, top shelf',
  overdue: true,
};

const view: SitterView = {
  label: 'The Smiths’ plants',
  expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  tasks: [waterTask],
};

describe('SitPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the due-task list with a warm, plain instruction', async () => {
    getView.mockResolvedValue(view);
    renderPage();

    expect(await screen.findByText(/Water the Monstera/i)).toBeInTheDocument();
    expect(screen.getByText(/Living Room · east window, top shelf/i)).toBeInTheDocument();
    expect(screen.getByText(/Overdue/i)).toBeInTheDocument();
    // Single h1 for accessibility.
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    // The token is passed straight through to the service.
    expect(getView).toHaveBeenCalledWith('a'.repeat(64), expect.anything());
  });

  it('checks a task off and removes it from the list (optimistic)', async () => {
    getView.mockResolvedValue(view);
    completeTask.mockResolvedValue({ ...waterTask, overdue: false });
    const user = userEvent.setup();
    renderPage();

    const doneBtn = await screen.findByRole('button', {
      name: /mark .*Water the Monstera.* as done/i,
    });
    await user.click(doneBtn);

    await waitFor(() => expect(screen.queryByText(/Water the Monstera/i)).not.toBeInTheDocument());
    expect(completeTask).toHaveBeenCalledWith('a'.repeat(64), 't1');
    expect(await screen.findByText(/all caught up/i)).toBeInTheDocument();
  });

  it('shows a friendly message for an expired / revoked link', async () => {
    getView.mockRejectedValue(new SitterLinkInactiveError());
    renderPage();

    expect(await screen.findByText(/no longer active/i)).toBeInTheDocument();
    // No raw error / stack — just the friendly copy.
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument();
  });

  it('shows a generic error for an unexpected failure', async () => {
    getView.mockRejectedValue(new Error('boom'));
    renderPage();
    expect(await screen.findByText(/something went wrong/i)).toBeInTheDocument();
  });

  it('falls back to the inactive screen if the link expires mid-session', async () => {
    getView.mockResolvedValue(view);
    completeTask.mockRejectedValue(new SitterLinkInactiveError());
    const user = userEvent.setup();
    renderPage();

    const doneBtn = await screen.findByRole('button', { name: /as done/i });
    await user.click(doneBtn);
    expect(await screen.findByText(/no longer active/i)).toBeInTheDocument();
  });
});
