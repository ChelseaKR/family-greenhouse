import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { AccountSettings } from '@/features/settings/AccountSettings';
import { useAuthStore } from '@/store/authStore';
import { server } from '../../msw/server';

const API = 'http://localhost:4000';
const NO_LINK = { active: false, createdAt: null, lastUsedAt: null };

vi.mock('@/services/plantService', async () => {
  const actual =
    await vi.importActual<typeof import('@/services/plantService')>('@/services/plantService');
  return {
    ...actual,
    plantService: { ...actual.plantService, getPlants: vi.fn() },
  };
});

vi.mock('@/services/taskService', async () => {
  const actual =
    await vi.importActual<typeof import('@/services/taskService')>('@/services/taskService');
  return {
    ...actual,
    taskService: { ...actual.taskService, getTasks: vi.fn() },
  };
});

// Stub the actual DOM download side-effect (Blob/anchor-click/URL APIs);
// we only care about what content was handed to it.
vi.mock('@/utils/csv', async () => {
  const actual = await vi.importActual<typeof import('@/utils/csv')>('@/utils/csv');
  return { ...actual, downloadCsv: vi.fn() };
});

function renderSettings() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AccountSettings />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('AccountSettings — CSV export', () => {
  beforeEach(async () => {
    useAuthStore.setState({
      user: {
        id: 'u-1',
        email: 'a@b.com',
        name: 'Alice',
        householdId: 'hh-1',
        householdRole: 'member',
      },
    } as never);
    const { taskService } = await import('@/services/taskService');
    vi.mocked(taskService.getTasks).mockResolvedValue([]);
    // The calendar-feed row reads its link status on mount.
    server.use(http.get(`${API}/me/calendar-token`, () => HttpResponse.json(NO_LINK)));
  });

  it('requests every plant (filter: "all"), including died/gave-away ones', async () => {
    const { plantService } = await import('@/services/plantService');
    const { downloadCsv } = await import('@/utils/csv');
    vi.mocked(plantService.getPlants).mockResolvedValueOnce([
      {
        id: 'p-died',
        householdId: 'hh-1',
        name: 'Fiddle Leaf Fig',
        species: null,
        location: null,
        imageUrl: null,
        notes: null,
        status: 'died',
        createdAt: '',
        createdBy: 'u-1',
        updatedAt: '',
      },
    ]);

    renderSettings();
    await userEvent.click(screen.getByRole('button', { name: /download csv/i }));

    // The bug: this call site omitted the filter, so getPlants' 'active'
    // default silently dropped died/gave-away plants from the export.
    await waitFor(() => expect(plantService.getPlants).toHaveBeenCalledWith('all'));
    await waitFor(() => expect(downloadCsv).toHaveBeenCalled());

    const plantsCsvCall = vi
      .mocked(downloadCsv)
      .mock.calls.find(([filename]) => filename.includes('plants'));
    expect(plantsCsvCall?.[1]).toContain('Fiddle Leaf Fig');
  });

  it('keeps deletion available before household setup and hides household-only exports', () => {
    useAuthStore.setState({
      user: {
        id: 'u-1',
        email: 'a@b.com',
        name: 'Alice',
        householdId: null,
        householdRole: null,
      },
    } as never);
    renderSettings();

    expect(screen.getByRole('button', { name: 'Delete my account' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download full data (JSON)' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download CSV' })).not.toBeInTheDocument();
    expect(screen.queryByText('Calendar feed')).not.toBeInTheDocument();
  });

  it('requires the Cognito password policy before enabling a password change', async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.type(screen.getByLabelText(/current password/i), 'old-password');
    await user.type(screen.getByLabelText(/^new password/i), 'password1234');
    await user.type(screen.getByLabelText(/confirm new password/i), 'password1234');

    expect(screen.getByRole('button', { name: /update password/i })).toBeDisabled();
    expect(screen.getByText(/at least 12 characters with uppercase/i)).toBeInTheDocument();

    await user.clear(screen.getByLabelText(/^new password/i));
    await user.clear(screen.getByLabelText(/confirm new password/i));
    await user.type(screen.getByLabelText(/^new password/i), 'Password1234');
    await user.type(screen.getByLabelText(/confirm new password/i), 'Password1234');

    expect(screen.getByRole('button', { name: /update password/i })).toBeEnabled();
  });
});

describe('AccountSettings — calendar feed link', () => {
  const TOKEN = 'a'.repeat(64);
  const PATH = `/calendar/${TOKEN}/family-greenhouse.ics`;
  const ACTIVE = {
    active: true,
    createdAt: '2026-09-01T00:00:00.000Z',
    lastUsedAt: '2026-09-02T00:00:00.000Z',
  };

  beforeEach(() => {
    useAuthStore.setState({
      user: {
        id: 'u-1',
        email: 'a@b.com',
        name: 'Alice',
        householdId: 'hh-1',
        householdRole: 'member',
      },
      activeHouseholdId: 'hh-1',
    } as never);
  });

  it('no longer hands out the bare /me/calendar.ics URL; it offers to generate a private link', async () => {
    // The bug: the row displayed `${API}/me/calendar.ics`, a JWT-guarded
    // route. Calendar apps carry no session, so every subscriber got 401.
    server.use(http.get(`${API}/me/calendar-token`, () => HttpResponse.json(NO_LINK)));
    renderSettings();

    expect(
      await screen.findByRole('button', { name: 'Generate calendar link' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Calendar feed URL' })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('/me/calendar.ics');
    // The read-access warning is up front, before the user mints anything.
    expect(screen.getByText(/anyone who has this link can read/i)).toBeInTheDocument();
  });

  it('mints a tokenised feed URL, shows it once with the warning, and never the bare route', async () => {
    let posted = 0;
    server.use(
      http.get(`${API}/me/calendar-token`, () => HttpResponse.json(NO_LINK)),
      http.post(`${API}/me/calendar-token`, () => {
        posted += 1;
        return HttpResponse.json(
          {
            active: true,
            createdAt: '2026-09-02T00:00:00.000Z',
            lastUsedAt: null,
            token: TOKEN,
            path: PATH,
          },
          { status: 201 }
        );
      })
    );
    renderSettings();

    await userEvent.click(await screen.findByRole('button', { name: 'Generate calendar link' }));

    const box = (await screen.findByRole('textbox', {
      name: 'Calendar feed URL',
    })) as HTMLInputElement;
    expect(box.value).toBe(`${API}${PATH}`);
    expect(box.value).not.toContain('/me/calendar.ics');
    expect(posted).toBe(1);
    expect(screen.getByText(/copy the link now/i)).toBeInTheDocument();
    expect(screen.getByText(/anyone who has this link can read/i)).toBeInTheDocument();
    // Regenerate/revoke are reachable straight away.
    expect(screen.getByRole('button', { name: 'Regenerate link' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke link' })).toBeInTheDocument();
  });

  it('after a reload, reports an active link (without the token) and offers regenerate + revoke', async () => {
    server.use(http.get(`${API}/me/calendar-token`, () => HttpResponse.json(ACTIVE)));
    renderSettings();

    expect(
      await screen.findByText(/a calendar link is active for this household/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/last fetched/i)).toBeInTheDocument();
    expect(screen.getByText(/can't be shown again/i)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Calendar feed URL' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Regenerate link' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke link' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Generate calendar link' })
    ).not.toBeInTheDocument();
  });

  it('regenerate asks for confirmation, then shows the NEW url once', async () => {
    const NEW_TOKEN = 'b'.repeat(64);
    server.use(
      http.get(`${API}/me/calendar-token`, () => HttpResponse.json(ACTIVE)),
      http.post(`${API}/me/calendar-token`, () =>
        HttpResponse.json(
          {
            active: true,
            createdAt: '2026-09-03T00:00:00.000Z',
            lastUsedAt: null,
            token: NEW_TOKEN,
            path: `/calendar/${NEW_TOKEN}/family-greenhouse.ics`,
          },
          { status: 201 }
        )
      )
    );
    renderSettings();

    await userEvent.click(await screen.findByRole('button', { name: 'Regenerate link' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/current link stops working immediately/i)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Yes, regenerate' }));

    const box = (await screen.findByRole('textbox', {
      name: 'Calendar feed URL',
    })) as HTMLInputElement;
    expect(box.value).toBe(`${API}/calendar/${NEW_TOKEN}/family-greenhouse.ics`);
  });

  it('revoke asks for confirmation, then returns to the generate state', async () => {
    let status = ACTIVE as { active: boolean; createdAt: string | null; lastUsedAt: string | null };
    let deleted = 0;
    server.use(
      http.get(`${API}/me/calendar-token`, () => HttpResponse.json(status)),
      http.delete(`${API}/me/calendar-token`, () => {
        deleted += 1;
        status = NO_LINK;
        return new HttpResponse(null, { status: 204 });
      })
    );
    renderSettings();

    await userEvent.click(await screen.findByRole('button', { name: 'Revoke link' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Yes, revoke' }));

    expect(await screen.findByText('Calendar link revoked.')).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: 'Generate calendar link' })
    ).toBeInTheDocument();
    expect(deleted).toBe(1);
    expect(screen.queryByRole('button', { name: 'Revoke link' })).not.toBeInTheDocument();
  });

  it('renders a failed status read as itself — not as "no link yet" (ADR 0010)', async () => {
    server.use(
      http.get(`${API}/me/calendar-token`, () =>
        HttpResponse.json({ message: 'boom' }, { status: 500 })
      )
    );
    renderSettings();

    expect(
      await screen.findByText(/couldn't check whether a calendar link exists/i)
    ).toBeInTheDocument();
    // A link issued earlier may still be live; the zero-state would read as
    // an all-clear nobody computed.
    expect(
      screen.queryByRole('button', { name: 'Generate calendar link' })
    ).not.toBeInTheDocument();
  });
});
