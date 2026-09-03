import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { WelcomeFlow } from '@/features/onboarding/WelcomeFlow';
import { HomeRedirect } from '@/features/onboarding/HomeRedirect';
import { useAuthStore } from '@/store/authStore';
import { usePrefsStore } from '@/store/prefsStore';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';

function signIn(role: 'admin' | 'member' = 'admin') {
  useAuthStore.setState({
    user: {
      id: 'u1',
      email: 'chelsea@example.com',
      name: 'Chelsea Kelly-Reif',
      householdId: 'hh-1',
      householdRole: role,
    },
    idToken: 'id-1',
    accessToken: 'access-1',
    isAuthenticated: true,
    isLoading: false,
  } as never);
}

/** Every read the first run makes, with the household empty and the caller an admin. */
function newHouseholdHandlers({
  plants = [] as unknown[],
  role = 'admin' as 'admin' | 'member',
  templates = [] as unknown[],
} = {}) {
  server.use(
    http.get(`${API}/plants`, () => HttpResponse.json(plants)),
    http.get(`${API}/me/households`, () =>
      HttpResponse.json([{ householdId: 'hh-1', name: 'Home', role, joinedAt: '' }])
    ),
    http.get(`${API}/tasks/templates`, () => HttpResponse.json(templates))
  );
}

function renderFirstRun(entry = '/welcome') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/" element={<HomeRedirect />} />
          <Route path="/welcome" element={<WelcomeFlow />} />
          <Route path="/dashboard" element={<h1>Dashboard</h1>} />
          <Route path="/plants/new" element={<h1>Add a new plant</h1>} />
          <Route path="/onboarding" element={<h1>Set up your household</h1>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

/** Walk to the invite step with the invite endpoint stubbed. */
async function goToInviteStep(user: ReturnType<typeof userEvent.setup>) {
  newHouseholdHandlers();
  server.use(
    http.post(`${API}/households/hh-1/invites`, () =>
      HttpResponse.json({
        code: 'INV123',
        url: 'https://familygreenhouse.net/join/INV123',
        expiresAt: '2026-09-30T00:00:00.000Z',
      })
    )
  );
  renderFirstRun();
  await user.click(await screen.findByRole('button', { name: /skip for now/i }));
}

beforeEach(() => {
  signIn();
  usePrefsStore.setState({ welcomeSeen: false });
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('HomeRedirect', () => {
  it('routes a brand-new household into the first run', async () => {
    newHouseholdHandlers();
    renderFirstRun('/');
    expect(await screen.findByRole('heading', { name: /add your first plant/i })).toBeVisible();
  });

  it('sends a user who has already seen the first run to the dashboard', async () => {
    usePrefsStore.setState({ welcomeSeen: true });
    renderFirstRun('/');
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });

  it('leaves a household-less user to the existing household-setup gate', async () => {
    useAuthStore.setState({
      user: {
        id: 'u1',
        email: 'chelsea@example.com',
        name: 'Chelsea',
        householdId: null,
        householdRole: null,
      },
    } as never);
    renderFirstRun('/');
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });
});

describe('WelcomeFlow gating', () => {
  it('steps aside for a household that already has plants, and records it', async () => {
    newHouseholdHandlers({ plants: [{ id: 'p1', name: 'Pothos' }] });
    renderFirstRun();

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await waitFor(() => expect(usePrefsStore.getState().welcomeSeen).toBe(true));
  });

  it('does not record a first run it skipped because the plants read failed', async () => {
    server.use(
      http.get(`${API}/plants`, () => HttpResponse.json({ message: 'boom' }, { status: 500 })),
      http.get(`${API}/me/households`, () =>
        HttpResponse.json([{ householdId: 'hh-1', name: 'Home', role: 'admin', joinedAt: '' }])
      )
    );
    renderFirstRun();

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeVisible();
    // A failed read is not "this household has no plants" and is not "the
    // first run happened" — the next successful load gets to decide.
    expect(usePrefsStore.getState().welcomeSeen).toBe(false);
  });
});

describe('WelcomeFlow activation path', () => {
  it('creates a real plant and then surfaces the shared-household invite', async () => {
    const user = userEvent.setup();
    const created: Array<Record<string, unknown>> = [];
    newHouseholdHandlers();
    server.use(
      http.post(`${API}/plants`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        created.push(body);
        return HttpResponse.json({ id: 'p-new', name: body.name, householdId: 'hh-1' });
      })
    );

    renderFirstRun();

    await user.type(await screen.findByLabelText(/plant name/i), 'Kitchen monstera');
    await user.click(screen.getByRole('button', { name: /add plant/i }));

    expect(await screen.findByRole('heading', { name: /share the care/i })).toBeVisible();
    expect(created).toEqual([{ name: 'Kitchen monstera' }]);
    // The plant exists, but the run is not over — nothing is marked seen
    // until the user actually leaves.
    expect(usePrefsStore.getState().welcomeSeen).toBe(false);
  });

  it('mints a real invite link on the invite step', async () => {
    const user = userEvent.setup();
    newHouseholdHandlers();
    server.use(
      http.post(`${API}/plants`, () =>
        HttpResponse.json({ id: 'p-new', name: 'Fern', householdId: 'hh-1' })
      ),
      http.post(`${API}/households/hh-1/invites`, () =>
        HttpResponse.json({
          code: 'INV123',
          url: 'https://familygreenhouse.net/join/INV123',
          expiresAt: '2026-09-30T00:00:00.000Z',
        })
      )
    );

    renderFirstRun();
    await user.type(await screen.findByLabelText(/plant name/i), 'Fern');
    await user.click(screen.getByRole('button', { name: /add plant/i }));

    await user.click(await screen.findByRole('button', { name: /create an invite link/i }));

    const link = await screen.findByLabelText(/invite link/i);
    expect(link).toHaveValue('https://familygreenhouse.net/join/INV123');
  });

  it('copies the invite link and confirms it out loud', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    await goToInviteStep(user);
    await user.click(await screen.findByRole('button', { name: /create an invite link/i }));
    await user.click(screen.getByRole('button', { name: /copy link/i }));

    expect(writeText).toHaveBeenCalledWith('https://familygreenhouse.net/join/INV123');
    expect(await screen.findByText(/invite link copied/i)).toBeVisible();
  });

  it('selects the link instead of failing silently when the clipboard is blocked', async () => {
    const user = userEvent.setup();
    // Locked-down profiles and Safari-without-a-gesture both land here; the
    // link must still be one keystroke away rather than a dead end.
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });

    await goToInviteStep(user);
    await user.click(await screen.findByRole('button', { name: /create an invite link/i }));
    await user.click(screen.getByRole('button', { name: /copy link/i }));

    expect(await screen.findByText(/couldn't copy it for you/i)).toBeVisible();
    expect(await screen.findByLabelText(/invite link/i)).toHaveFocus();
  });

  it('lets a solo user skip the invite entirely', async () => {
    const user = userEvent.setup();
    newHouseholdHandlers();
    server.use(
      http.post(`${API}/plants`, () =>
        HttpResponse.json({ id: 'p-new', name: 'Fern', householdId: 'hh-1' })
      )
    );

    renderFirstRun();
    await user.type(await screen.findByLabelText(/plant name/i), 'Fern');
    await user.click(screen.getByRole('button', { name: /add plant/i }));
    await user.click(await screen.findByRole('button', { name: /just me for now/i }));

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeVisible();
    expect(usePrefsStore.getState().welcomeSeen).toBe(true);
  });

  it('skipping the plant step still shows what makes the product different', async () => {
    const user = userEvent.setup();
    newHouseholdHandlers();
    renderFirstRun();

    await user.click(await screen.findByRole('button', { name: /skip for now/i }));

    expect(await screen.findByRole('heading', { name: /share the care/i })).toBeVisible();
  });

  it('moves focus to the new step heading so keyboard users are not stranded', async () => {
    const user = userEvent.setup();
    newHouseholdHandlers();
    renderFirstRun();

    await user.click(await screen.findByRole('button', { name: /skip for now/i }));

    const heading = await screen.findByRole('heading', { name: /share the care/i });
    await waitFor(() => expect(heading).toHaveFocus());
  });

  it('hands off to the full add-plant page on request', async () => {
    const user = userEvent.setup();
    newHouseholdHandlers();
    renderFirstRun();

    await user.click(await screen.findByRole('button', { name: /add photos, spaces/i }));

    expect(await screen.findByRole('heading', { name: 'Add a new plant' })).toBeVisible();
    expect(usePrefsStore.getState().welcomeSeen).toBe(true);
  });

  it('never offers a member the invite step they are not allowed to use', async () => {
    const user = userEvent.setup();
    signIn('member');
    newHouseholdHandlers({ role: 'member' });
    server.use(
      http.post(`${API}/plants`, () =>
        HttpResponse.json({ id: 'p-new', name: 'Fern', householdId: 'hh-1' })
      )
    );

    renderFirstRun();
    await user.type(await screen.findByLabelText(/plant name/i), 'Fern');
    await user.click(screen.getByRole('button', { name: /add plant/i }));

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });
});

describe('WelcomeFlow care-schedule honesty', () => {
  it('says it could not check when the template catalog read fails', async () => {
    const user = userEvent.setup();
    newHouseholdHandlers();
    server.use(
      http.get(`${API}/tasks/templates`, () =>
        HttpResponse.json({ message: 'boom' }, { status: 500 })
      )
    );

    renderFirstRun();
    await user.type(await screen.findByLabelText(/species/i), 'Monstera deliciosa');

    // Crucially NOT "we don't have a schedule for that" — that is a finding,
    // and a failed read did not produce one.
    expect(await screen.findByText(/couldn't check for a care schedule/i)).toBeVisible();
  });

  it('offers a matching curated schedule and applies it to the new plant', async () => {
    const user = userEvent.setup();
    const applied: string[] = [];
    newHouseholdHandlers({
      templates: [
        {
          id: 'tropical',
          name: 'Tropical foliage',
          description: 'Water weekly, feed monthly in spring and summer.',
          suitsKeywords: ['monstera'],
          tasks: [{ type: 'water', frequencyDays: 7 }],
        },
      ],
    });
    server.use(
      http.post(`${API}/plants`, () =>
        HttpResponse.json({ id: 'p-new', name: 'Monty', householdId: 'hh-1' })
      ),
      http.post(`${API}/plants/p-new/apply-template`, async ({ request }) => {
        const body = (await request.json()) as { templateId: string };
        applied.push(body.templateId);
        return HttpResponse.json({ created: [{ id: 't1' }] });
      })
    );

    renderFirstRun();
    await user.type(await screen.findByLabelText(/plant name/i), 'Monty');
    await user.type(screen.getByLabelText(/species/i), 'Monstera deliciosa');

    expect(await screen.findByText(/Tropical foliage/)).toBeVisible();

    await user.click(screen.getByRole('button', { name: /add plant/i }));

    await waitFor(() => expect(applied).toEqual(['tropical']));
  });

  it('does not invent a schedule for a species it does not recognise', async () => {
    const user = userEvent.setup();
    newHouseholdHandlers({ templates: [] });
    renderFirstRun();

    await user.type(await screen.findByLabelText(/species/i), 'Totally unknown plant');

    expect(await screen.findByText(/won't guess at one/i)).toBeVisible();
  });
});
