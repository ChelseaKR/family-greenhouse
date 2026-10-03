import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { LeaveHouseholdCard } from '@/features/household/LeaveHouseholdCard';
import { MovePlantsDialog } from '@/features/plants/MovePlantsDialog';
import { PlantDetailPage } from '@/features/plants/PlantDetailPage';
import type { NativePresentRequest } from '@/config/nativePresent';
import type { HouseholdMember } from '@/services/householdService';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

/**
 * Confirmations and choices as Apple's own alerts and action sheets in the
 * iOS app (NativeChrome `present`), with the plugin replaced by a fake that
 * lets each test play the person: tap a button, tap Cancel, swipe it away,
 * or send the app to the background (Swift answers `{ id: null }` for every
 * ending but a tap on a non-cancel button; NativePresentModel.swift).
 *
 * The data-risk paths (Remove plant, Leave household, bulk Move) are checked
 * against the network: every request that is not a GET is recorded, and
 * "data unchanged" means that list is empty.
 */

interface Pending {
  request: NativePresentRequest;
  answer: (result: unknown) => void;
  fail: () => void;
}

const native = vi.hoisted(() => ({
  pending: [] as Array<{
    request: unknown;
    answer: (result: unknown) => void;
    fail: () => void;
  }>,
  updates: [] as unknown[],
  dismissed: [] as unknown[],
}));

vi.mock('@/services/nativeChrome', () => ({
  NativeChrome: {
    present: (request: unknown) =>
      new Promise((resolve, reject) => {
        native.pending.push({ request, answer: resolve, fail: () => reject(new Error('x')) });
      }),
    updatePresented: (options: unknown) => {
      native.updates.push(options);
      return Promise.resolve();
    },
    dismissPresented: (options: unknown) => {
      native.dismissed.push(options);
      return Promise.resolve();
    },
  },
}));

const API = 'http://localhost:4000';
let writes: string[] = [];

function pretendToBeTheIosApp() {
  (window as unknown as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'ios',
    PluginHeaders: [
      {
        name: 'NativeChrome',
        methods: ['configure', 'update', 'present', 'updatePresented', 'dismissPresented'].map(
          (name) => ({ name })
        ),
      },
    ],
  };
}

/** The alert or sheet showing now (the latest `present` not yet answered). */
async function presented(count = 1): Promise<Pending> {
  await waitFor(() => expect(native.pending.length).toBeGreaterThanOrEqual(count));
  return native.pending[count - 1] as Pending;
}

/** The person ends it: a button's id, or null for Cancel / outside / swipe / background. */
async function answer(sheet: Pending, id: string | null) {
  await act(async () => {
    sheet.answer({ id });
    await Promise.resolve();
  });
}

beforeEach(() => {
  native.pending.length = 0;
  native.updates.length = 0;
  native.dismissed.length = 0;
  writes = [];
  server.events.on('request:start', ({ request }) => {
    if (request.method !== 'GET') writes.push(`${request.method} ${new URL(request.url).pathname}`);
  });
  pretendToBeTheIosApp();
});

afterEach(() => {
  server.events.removeAllListeners();
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
});

describe('ConfirmDialog in the iOS app', () => {
  function renderConfirm(props: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    const view = render(
      <ConfirmDialog
        isOpen
        onClose={onClose}
        onConfirm={onConfirm}
        title="Revoke API key?"
        message="The key stops working."
        confirmLabel="Revoke"
        {...props}
      />
    );
    return { onClose, onConfirm, ...view };
  }

  it('opens a native alert, not a web dialog: the confirm button red, Cancel apart', async () => {
    renderConfirm();
    const sheet = await presented();
    expect(sheet.request).toMatchObject({
      kind: 'alert',
      title: 'Revoke API key?',
      message: 'The key stops working.',
      actions: [
        { id: 'confirm', title: 'Revoke', style: 'destructive' },
        { id: 'cancel', title: 'Cancel', style: 'cancel' },
      ],
    });
    expect(sheet.request.token).toMatch(/\S/);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('confirms only on the confirm button', async () => {
    const { onClose, onConfirm } = renderConfirm();
    await answer(await presented(), 'confirm');
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each([
    ['Cancel', 'cancel'],
    ['a tap outside, a swipe or the background (no choice)', null],
    ['an id it never offered', 'Revoke'],
  ])('%s closes without confirming', async (_how, id) => {
    const { onClose, onConfirm } = renderConfirm();
    await answer(await presented(), id);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a failed bridge call closes without confirming', async () => {
    const { onClose, onConfirm } = renderConfirm();
    const sheet = await presented();
    await act(async () => {
      sheet.fail();
      await Promise.resolve();
    });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closed by the app: the alert is dismissed, and a late answer confirms nothing', async () => {
    const { onClose, onConfirm, rerender } = renderConfirm();
    const sheet = await presented();
    rerender(
      <ConfirmDialog
        isOpen={false}
        onClose={onClose}
        onConfirm={onConfirm}
        title="Revoke API key?"
        message="The key stops working."
      />
    );
    await waitFor(() => expect(native.dismissed).toEqual([{ token: sheet.request.token }]));
    await answer(sheet, 'confirm');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('unmounted while showing: dismissed, and nothing confirms', async () => {
    const { onConfirm, unmount } = renderConfirm();
    const sheet = await presented();
    unmount();
    expect(native.dismissed).toEqual([{ token: sheet.request.token }]);
    await answer(sheet, 'confirm');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('new words while it shows go to the alert showing', async () => {
    const { rerender, onClose, onConfirm } = renderConfirm();
    const sheet = await presented();
    rerender(
      <ConfirmDialog
        isOpen
        onClose={onClose}
        onConfirm={onConfirm}
        title="Revoke API key?"
        message="The key stops working. 2 integrations use it."
        confirmLabel="Revoke"
      />
    );
    await waitFor(() =>
      expect(native.updates).toEqual([
        {
          token: sheet.request.token,
          title: 'Revoke API key?',
          message: 'The key stops working. 2 integrations use it.',
        },
      ])
    );
    expect(native.pending).toHaveLength(1);
  });

  it('after a confirmed action fails, the dialog closes so its button works again', async () => {
    const { onClose, onConfirm, rerender } = renderConfirm({ isLoading: false });
    await answer(await presented(), 'confirm');
    const props = {
      isOpen: true,
      onClose,
      onConfirm,
      title: 'Revoke API key?',
      message: 'The key stops working.',
      confirmLabel: 'Revoke',
    };
    rerender(<ConfirmDialog {...props} isLoading />);
    rerender(<ConfirmDialog {...props} isLoading={false} />);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('on the website: the web dialog, and the plugin is never asked', async () => {
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
    renderConfirm();
    expect(await screen.findByRole('dialog', { name: 'Revoke API key?' })).toBeInTheDocument();
    expect(native.pending).toHaveLength(0);
  });
});

// --- Remove plant (data) -------------------------------------------------------

const plant = {
  id: 'p1',
  householdId: 'hh',
  name: 'Pothos',
  species: null,
  location: null,
  imageUrl: null,
  notes: null,
  createdAt: '2026-04-25T00:00:00.000Z',
  createdBy: 'u1',
  updatedAt: '2026-04-25T00:00:00.000Z',
  upcomingTasks: [
    {
      id: 't1',
      plantId: 'p1',
      plantName: 'Pothos',
      type: 'water',
      customType: null,
      frequency: 7,
      lastCompleted: null,
      nextDue: '2099-01-01T00:00:00.000Z',
      assignedTo: null,
      assignedToName: null,
      notes: null,
      createdBy: '',
      createdAt: '',
    },
  ],
  recentCompletions: [],
};

function renderPlant() {
  useAuthStore.setState({ accessToken: 'access-1' });
  server.use(
    http.get(`${API}/plants/p1`, () => HttpResponse.json(plant)),
    http.put(`${API}/plants/p1`, async ({ request }) =>
      HttpResponse.json({ ...plant, ...((await request.json()) as object) })
    ),
    http.delete(`${API}/plants/p1`, () => new HttpResponse(null, { status: 204 })),
    http.post(`${API}/tasks/t1/snooze`, () => HttpResponse.json(plant.upcomingTasks[0]))
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/plants/p1']}>
        <Routes>
          <Route path="/plants/:plantId" element={<PlantDetailPage />} />
          <Route path="/plants/:plantId/passport" element={<p>passport page</p>} />
          <Route path="/plants" element={<p>Plants Index</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

async function openRemove(count: number) {
  // In the app the plant page's actions are in its "…" menu (the web menu
  // here, since this fake app has no bar tools); Remove… is one of them.
  await userEvent.click(await screen.findByLabelText('More plant actions'));
  await userEvent.click(await screen.findByRole('button', { name: 'Remove…' }));
  return presented(count);
}

describe('Remove plant in the iOS app (data)', () => {
  it('is an action sheet: the outcomes, Delete in red, Cancel apart; no web dialog', async () => {
    renderPlant();
    const sheet = await openRemove(1);
    expect(sheet.request).toMatchObject({
      kind: 'actionSheet',
      title: 'Move Pothos out of active care?',
    });
    expect(sheet.request.actions.map((a) => [a.id, a.style])).toEqual([
      ['archive', 'default'],
      ['gaveAway', 'default'],
      ['passport', 'default'],
      ['died', 'default'],
      ['delete', 'destructive'],
      ['cancel', 'cancel'],
    ]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('Cancel, a swipe or tap outside, and backgrounding change nothing; it opens again after each', async () => {
    renderPlant();
    // Cancel, then "no choice" (how Swift answers a tap outside, a swipe and
    // the app going to the background), three times over.
    const endings: Array<string | null> = ['cancel', null, null];
    for (const [index, ending] of endings.entries()) {
      await answer(await openRemove(index + 1), ending);
    }
    expect(native.pending).toHaveLength(3);
    expect(screen.getByRole('heading', { name: 'Pothos' })).toBeInTheDocument();
    expect(writes).toEqual([]);

    // The same sheet still does what it says when a choice IS made.
    await answer(await openRemove(4), 'archive');
    await waitFor(() => expect(writes).toEqual(['PUT /plants/p1']));
    expect(await screen.findByText('Plants Index')).toBeInTheDocument();
  });

  it('Delete asks again in a red alert; dismissing that deletes nothing', async () => {
    renderPlant();
    await answer(await openRemove(1), 'delete');
    const confirm = await presented(2);
    expect(confirm.request).toMatchObject({
      kind: 'alert',
      actions: [
        { id: 'confirm', style: 'destructive' },
        { id: 'cancel', style: 'cancel' },
      ],
    });
    await answer(confirm, null);
    await answer(await openRemove(3), 'delete');
    await answer(await presented(4), 'cancel');
    expect(writes).toEqual([]);

    await answer(await openRemove(5), 'delete');
    await answer(await presented(6), 'confirm');
    await waitFor(() => expect(writes).toEqual(['DELETE /plants/p1']));
  });

  it('the passport choice only opens the passport', async () => {
    renderPlant();
    await answer(await openRemove(1), 'passport');
    expect(await screen.findByText('passport page')).toBeInTheDocument();
    expect(writes).toEqual([]);
  });

  it('snooze: an action sheet of durations; only a duration snoozes', async () => {
    renderPlant();
    await userEvent.click(await screen.findByLabelText('Snooze task'));
    const sheet = await presented(1);
    expect(sheet.request).toMatchObject({ kind: 'actionSheet', title: 'Snooze' });
    expect(sheet.request.actions.map((a) => a.title)).toEqual([
      '1 day',
      '3 days',
      '1 week',
      'Skip cycle',
      'Cancel',
    ]);
    await answer(sheet, null);
    await userEvent.click(screen.getByLabelText('Snooze task'));
    await answer(await presented(2), 'cancel');
    expect(writes).toEqual([]);
    await userEvent.click(screen.getByLabelText('Snooze task'));
    await answer(await presented(3), 'snooze-3');
    await waitFor(() => expect(writes).toEqual(['POST /tasks/t1/snooze']));
  });
});

// --- Leave household (data) ----------------------------------------------------

describe('Leave household in the iOS app (data)', () => {
  const me: HouseholdMember = { userId: 'user-1', name: 'Alice', role: 'member', joinedAt: '' };
  const admin: HouseholdMember = { userId: 'user-2', name: 'Bo', role: 'admin', joinedAt: '' };

  beforeEach(() => {
    useAuthStore.setState({
      isAuthenticated: true,
      idToken: 'id-token-1',
      refreshToken: null,
      activeHouseholdId: 'hh-2',
      user: {
        id: 'user-1',
        email: 'alice@example.com',
        name: 'Alice',
        householdId: 'hh-1',
        householdRole: 'admin',
      },
    } as never);
    server.use(
      http.get(`${API}/tasks`, () => HttpResponse.json([{ id: 't1' }, { id: 't2' }])),
      http.post(`${API}/households/hh-2/leave`, () =>
        HttpResponse.json({
          householdId: 'hh-2',
          releasedTasks: 2,
          revokedCredentials: { plantTags: 0, sitterLinks: 0, kioskLinks: 0, cuttingShares: 0 },
          defaultHouseholdId: 'hh-1',
          defaultHouseholdRole: 'admin',
          remainingHouseholds: 1,
        })
      )
    );
  });

  function renderLeave() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/household']}>
          <Routes>
            <Route
              path="/household"
              element={
                <LeaveHouseholdCard
                  householdId="hh-2"
                  householdName="Maple Street"
                  members={[me, admin]}
                />
              }
            />
            <Route path="/dashboard" element={<p>dashboard page</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
  }

  it('a red alert with Stay as the way out; the task count arrives in the alert showing', async () => {
    renderLeave();
    await userEvent.click(screen.getByRole('button', { name: 'Leave household' }));
    const sheet = await presented();
    expect(sheet.request).toMatchObject({
      kind: 'alert',
      title: 'Leave Maple Street?',
      actions: [
        { id: 'confirm', title: 'Leave household', style: 'destructive' },
        { id: 'cancel', title: 'Stay', style: 'cancel' },
      ],
    });
    await waitFor(() =>
      expect(native.updates.at(-1)).toMatchObject({
        token: sheet.request.token,
        message: expect.stringMatching(/You have 2 tasks with your name on them/),
      })
    );
  });

  it('Stay, a swipe or tap outside, and backgrounding leave nothing; only Leave leaves', async () => {
    renderLeave();
    for (const [index, ending] of (['cancel', null, null] as const).entries()) {
      await userEvent.click(screen.getByRole('button', { name: 'Leave household' }));
      await answer(await presented(index + 1), ending);
    }
    expect(writes).toEqual([]);
    expect(screen.queryByText('dashboard page')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Leave household' }));
    await answer(await presented(4), 'confirm');
    await waitFor(() => expect(writes).toEqual(['POST /households/hh-2/leave']));
    expect(await screen.findByText('dashboard page')).toBeInTheDocument();
  });
});

// --- Bulk move (data): stays a web form in the app ----------------------------

describe('bulk Move in the iOS app (data)', () => {
  it('is still the web form; Cancel, Escape and the app going to the background move nothing', async () => {
    useAuthStore.setState({ accessToken: 'access-1', activeHouseholdId: 'hh' } as never);
    server.use(
      http.get(`${API}/plants`, () => HttpResponse.json([{ ...plant, upcomingTasks: undefined }])),
      http.post(`${API}/plants/move`, () => HttpResponse.json([]))
    );
    const onClose = vi.fn();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <MovePlantsDialog isOpen onClose={onClose} />
      </QueryClientProvider>
    );
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(await screen.findByRole('checkbox', { name: /Pothos/ }));

    // The app goes to the background and comes back.
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(dialog).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(
      <QueryClientProvider client={queryClient}>
        <MovePlantsDialog isOpen onClose={onClose} />
      </QueryClientProvider>
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(writes).toEqual([]);
    expect(native.pending).toHaveLength(0);
  });
});
