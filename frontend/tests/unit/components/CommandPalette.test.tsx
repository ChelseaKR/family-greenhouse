import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { CommandPalette } from '@/components/CommandPalette';
import { useAuthStore } from '@/store/authStore';
import { plantService } from '@/services/plantService';
import { taskService } from '@/services/taskService';

vi.mock('@/services/plantService', () => ({
  plantService: { getPlants: vi.fn() },
}));
vi.mock('@/services/taskService', () => ({
  taskService: { getTasks: vi.fn() },
}));

const fern = { id: 'p1', name: 'Fern', species: 'Nephrolepis', location: 'Hall' };

async function openAndType(text: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <CommandPalette />
      </MemoryRouter>
    </QueryClientProvider>
  );
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  await userEvent.type(await screen.findByRole('combobox'), text);
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({
    user: { id: 'u1', email: 'a@example.com', name: 'A', householdId: 'hh-1' },
    activeHouseholdId: 'hh-1',
  } as never);
});

/**
 * "No matches" is a statement about the household's plants and tasks. It may
 * only be made once both lists were actually read — not while they are still
 * loading, and not when the read failed (ADR 0010).
 */
describe('CommandPalette', () => {
  it('names the dialog and labels the search field', async () => {
    // The dialog had no accessible name, and the field's only name was its
    // placeholder, which goes away as soon as something is typed.
    vi.mocked(plantService.getPlants).mockResolvedValue([fern] as never);
    vi.mocked(taskService.getTasks).mockResolvedValue([]);
    await openAndType('f');

    expect(screen.getByRole('dialog', { name: 'Search plants and tasks' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Search plants and tasks' })).toHaveValue('f');
  });

  it('finds a plant once the lists have loaded', async () => {
    vi.mocked(plantService.getPlants).mockResolvedValue([fern] as never);
    vi.mocked(taskService.getTasks).mockResolvedValue([]);
    await openAndType('fern');

    expect(await screen.findByRole('option', { name: /Fern/ })).toBeInTheDocument();
    expect(screen.queryByText(/No matches/)).not.toBeInTheDocument();
  });

  it('says it is loading, not "No matches", while the lists are still being read', async () => {
    vi.mocked(plantService.getPlants).mockReturnValue(new Promise(() => {}));
    vi.mocked(taskService.getTasks).mockResolvedValue([]);
    await openAndType('fern');

    expect(await screen.findByRole('status')).toHaveTextContent('Loading…');
    expect(screen.queryByText(/No matches/)).not.toBeInTheDocument();
  });

  it('says the search failed, not "No matches", when a list could not be read', async () => {
    vi.mocked(plantService.getPlants).mockRejectedValue(new Error('offline'));
    vi.mocked(taskService.getTasks).mockResolvedValue([]);
    await openAndType('fern');

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
    expect(screen.queryByText(/No matches/)).not.toBeInTheDocument();
  });

  it('says "No matches" when both lists were read and nothing matched', async () => {
    vi.mocked(plantService.getPlants).mockResolvedValue([fern] as never);
    vi.mocked(taskService.getTasks).mockResolvedValue([]);
    await openAndType('cactus');

    const empty = await screen.findByText(/No matches for/);
    expect(empty).toBeInTheDocument();
    // Announced, like the loading and failed lines: typing into a search that
    // finds nothing was silent for a screen reader (WCAG 4.1.3).
    expect(empty).toHaveAttribute('role', 'status');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
