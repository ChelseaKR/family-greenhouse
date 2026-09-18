import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { TrashSettings } from '@/features/settings/TrashSettings';
import { useToastStore } from '@/store/toastStore';
import { server } from '../../msw/server';

vi.mock('@/hooks/useActiveHouseholdId', () => ({
  useActiveHouseholdId: () => 'hh-1',
}));

const API = 'http://localhost:4000';

/**
 * Settings → Trash (#670). The load-bearing behaviour is ADR 0010's: a FAILED
 * listing must never read as "The trash is empty" — that sentence tells
 * someone who just deleted the wrong plant that it is gone for good.
 */
const plantEntry = {
  kind: 'plant',
  id: 'p1',
  name: 'Monstera',
  taskType: null,
  plantId: 'p1',
  plantName: 'Monstera',
  deletedAt: '2026-09-10T00:00:00.000Z',
  deletedByName: 'Mel Member',
  purgeAfter: '2026-10-10T00:00:00.000Z',
  contents: { tasks: 2, photos: 5, completions: 14 },
  restoring: false,
};
const taskEntry = {
  kind: 'task',
  id: 't1',
  name: 'water',
  taskType: 'water',
  plantId: 'p2',
  plantName: 'Fern',
  deletedAt: '2026-09-09T00:00:00.000Z',
  deletedByName: 'Ada Admin',
  purgeAfter: '2026-10-09T00:00:00.000Z',
  contents: null,
  restoring: false,
};

function renderPanel(listing: unknown | 'fail') {
  server.use(
    http.get(`${API}/households/hh-1/trash`, () =>
      listing === 'fail' ? new HttpResponse(null, { status: 500 }) : HttpResponse.json(listing)
    )
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TrashSettings />
    </QueryClientProvider>
  );
}

describe('TrashSettings', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
  });

  it('lists what is in the trash, with who deleted it and what went with it', async () => {
    renderPanel({ retentionDays: 30, entries: [plantEntry, taskEntry] });
    const list = await screen.findByRole('list', { name: /items in the trash/i });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('Monstera')).toBeInTheDocument();
    expect(within(rows[0]).getByText(/Deleted by Mel Member/)).toBeInTheDocument();
    expect(
      within(rows[0]).getByText('Tasks: 2 · Photos: 5 · Care records: 14')
    ).toBeInTheDocument();
    // A task is labelled by its translated type and its plant.
    expect(within(rows[1]).getByText(/Water · Fern/)).toBeInTheDocument();
    expect(screen.getByText(/wait here for 30 days/i)).toBeInTheDocument();
  });

  it('says the trash is empty only when the read actually succeeded', async () => {
    renderPanel({ retentionDays: 30, entries: [] });
    expect(await screen.findByText(/The trash is empty/i)).toBeInTheDocument();
  });

  it('says it could not load when the read fails — not "empty"', async () => {
    renderPanel('fail');
    expect(await screen.findByText(/couldn’t load the trash/i)).toBeVisible();
    expect(screen.queryByText(/The trash is empty/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('restores an entry and confirms it', async () => {
    const restore = vi.fn();
    server.use(
      http.post(`${API}/households/hh-1/trash/plant/p1/restore`, () => {
        restore();
        return HttpResponse.json({ ...plantEntry, restoring: false });
      })
    );
    renderPanel({ retentionDays: 30, entries: [plantEntry] });
    await userEvent.click(await screen.findByRole('button', { name: /restore monstera/i }));
    await waitFor(() => expect(restore).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(useToastStore.getState().toasts.map((t) => t.message)).toContain('Restored “Monstera”')
    );
  });

  it('shows the server’s refusal (the plant cap) in place, not a silent failure', async () => {
    server.use(
      http.post(`${API}/households/hh-1/trash/plant/p1/restore`, () =>
        HttpResponse.json(
          {
            message:
              'Your Seedling plan is limited to 20 plants. Remove or archive a plant before adding more.',
          },
          { status: 402 }
        )
      )
    );
    renderPanel({ retentionDays: 30, entries: [plantEntry] });
    await userEvent.click(await screen.findByRole('button', { name: /restore monstera/i }));
    expect(await screen.findByText(/limited to 20 plants/i)).toBeVisible();
  });

  it('deletes now only after an explicit confirmation', async () => {
    const purge = vi.fn();
    server.use(
      http.delete(`${API}/households/hh-1/trash/plant/p1`, () => {
        purge();
        return new HttpResponse(null, { status: 204 });
      })
    );
    renderPanel({ retentionDays: 30, entries: [plantEntry] });
    await userEvent.click(
      await screen.findByRole('button', { name: /delete monstera permanently now/i })
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/can’t be undone/i)).toBeInTheDocument();
    expect(purge).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: /^delete now$/i }));
    await waitFor(() => expect(purge).toHaveBeenCalledTimes(1));
  });

  it('offers to finish an interrupted restore, and no delete-now for it', async () => {
    renderPanel({ retentionDays: 30, entries: [{ ...plantEntry, restoring: true }] });
    expect(await screen.findByText(/A restore didn’t finish/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /restore monstera/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /permanently now/i })).not.toBeInTheDocument();
  });
});
