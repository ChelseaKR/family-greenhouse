import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AccountSettings } from '@/features/settings/AccountSettings';
import { useAuthStore } from '@/store/authStore';

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
