import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ClaimControls } from '@/features/tasks/taskRowExtras';
import type { TaskWithCoverage } from '@/services/taskService';
import { useAuthStore } from '@/store/authStore';

const task: TaskWithCoverage = {
  id: 'task-1',
  plantId: 'plant-1',
  plantName: 'Monstera',
  type: 'water',
  frequency: 7,
  lastCompleted: null,
  nextDue: '2026-07-20T08:00:00.000Z',
  assignedTo: 'usual-caregiver',
  assignedToName: 'Alex',
  assignmentSource: 'space_default',
  notes: null,
  createdBy: 'creator',
  createdAt: '2026-07-15T08:00:00.000Z',
};

describe('ClaimControls', () => {
  beforeEach(() => {
    useAuthStore.setState({
      user: {
        id: 'helper',
        email: 'helper@example.com',
        name: 'Sam',
        householdId: 'household-1',
        householdRole: 'member',
      },
    });
  });

  it('lets another household member take over a space-inherited assignment', async () => {
    const onClaim = vi.fn();
    render(<ClaimControls task={task} onClaim={onClaim} onUnclaim={vi.fn()} isPending={false} />);

    await userEvent.click(screen.getByRole('button', { name: /take over care for monstera/i }));
    expect(onClaim).toHaveBeenCalledWith('task-1');
  });

  it('does not expose takeover for an explicit assignment to someone else', () => {
    render(
      <ClaimControls
        task={{ ...task, assignmentSource: null }}
        onClaim={vi.fn()}
        onUnclaim={vi.fn()}
        isPending={false}
      />
    );

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
