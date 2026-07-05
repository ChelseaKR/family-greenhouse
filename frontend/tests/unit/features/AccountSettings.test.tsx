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
});
