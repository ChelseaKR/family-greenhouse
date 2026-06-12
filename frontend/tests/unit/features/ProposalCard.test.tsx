import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProposalCard } from '@/features/chat/ProposalCard';
import { taskService } from '@/services/taskService';
import type { ProposedReminderTask } from '@/services/chatService';

vi.mock('@/services/taskService', () => ({
  taskService: {
    createTask: vi.fn(),
  },
}));

const proposal: ProposedReminderTask = {
  proposalId: 'prop-1',
  plantId: 'p1',
  plantName: 'Bertha',
  type: 'water',
  customType: null,
  frequencyDays: 7,
  assignedTo: 'member-1',
  assigneeName: 'Chelsea',
  note: null,
  rationale: 'tropicals like weekly water',
};

function setup(p: ProposedReminderTask = proposal) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
  render(
    <QueryClientProvider client={queryClient}>
      <ProposalCard proposal={p} />
    </QueryClientProvider>
  );
  return { invalidateSpy };
}

beforeEach(() => {
  vi.mocked(taskService.createTask).mockReset();
});

describe('ProposalCard', () => {
  it('renders the proposal: plant, type, frequency, assignee, rationale, and both actions', () => {
    setup();
    expect(screen.getByText(/suggested reminder: water for bertha/i)).toBeInTheDocument();
    expect(screen.getByText(/every 7 days/i)).toBeInTheDocument();
    expect(screen.getByText(/assigned to chelsea/i)).toBeInTheDocument();
    expect(screen.getByText(/tropicals like weekly water/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create task/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument();
  });

  it('labels custom tasks with their customType', () => {
    setup({ ...proposal, type: 'custom', customType: 'mist leaves' });
    expect(screen.getByText(/suggested reminder: mist leaves for bertha/i)).toBeInTheDocument();
  });

  it('creates the task through the normal tasks endpoint and shows the success state', async () => {
    const user = userEvent.setup();
    vi.mocked(taskService.createTask).mockResolvedValueOnce({ id: 't1' } as never);
    const { invalidateSpy } = setup();

    await user.click(screen.getByRole('button', { name: /create task/i }));

    // The proposal maps onto the existing CreateTaskData contract —
    // frequencyDays → frequency, note → notes.
    expect(taskService.createTask).toHaveBeenCalledTimes(1);
    expect(taskService.createTask).toHaveBeenCalledWith({
      plantId: 'p1',
      type: 'water',
      customType: undefined,
      frequency: 7,
      assignedTo: 'member-1',
      notes: undefined,
    });
    expect(await screen.findByText(/reminder created: water for bertha/i)).toBeInTheDocument();
    // Buttons are gone — no double-create.
    expect(screen.queryByRole('button', { name: /create task/i })).not.toBeInTheDocument();
    // Tasks page + dashboard pick up the new reminder via the household key.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tasks', null] });
  });

  it('shows the error and keeps the card actionable when creation fails', async () => {
    const user = userEvent.setup();
    vi.mocked(taskService.createTask).mockRejectedValueOnce(new Error('Plan limit reached'));
    setup();

    await user.click(screen.getByRole('button', { name: /create task/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/plan limit reached/i);
    expect(screen.getByRole('button', { name: /create task/i })).toBeInTheDocument();
  });

  it('dismiss hides the card without creating anything', async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole('button', { name: /dismiss/i }));

    expect(screen.queryByTestId('proposal-card')).not.toBeInTheDocument();
    expect(taskService.createTask).not.toHaveBeenCalled();
  });
});
