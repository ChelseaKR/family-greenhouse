/**
 * "Ask family to do it" (ADR 0024) on the task row: when the button is
 * offered, what the badge says once an ask is open, and that the note the
 * asker left actually reaches the people who see the row.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AskedForHelpBadge, AskFamilyButton } from '@/features/tasks/taskRowExtras';
import { isHelpRequestOpen } from '@/features/tasks/helpRequest';
import { AskFamilyDialog } from '@/features/tasks/AskFamilyDialog';
import type { TaskWithCoverage } from '@/services/taskService';
import { useAuthStore } from '@/store/authStore';

const DUE = '2026-09-06T08:00:00.000Z';

const task: TaskWithCoverage = {
  id: 'task-1',
  plantId: 'plant-1',
  plantName: 'Monstera',
  type: 'water',
  frequency: 7,
  lastCompleted: null,
  nextDue: DUE,
  assignedTo: null,
  assignedToName: null,
  assignmentSource: null,
  notes: null,
  createdBy: 'creator',
  createdAt: '2026-09-01T08:00:00.000Z',
};

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

describe('isHelpRequestOpen', () => {
  it('is open only for the occurrence that was asked about, and only while unclaimed', () => {
    expect(isHelpRequestOpen({ ...task, helpAskedForDue: DUE })).toBe(true);
    // Someone claimed it — taking the task on IS the cancel.
    expect(isHelpRequestOpen({ ...task, helpAskedForDue: DUE, assignedTo: 'priya' })).toBe(false);
    // Completed since: nextDue advanced, so a stale note can never resurface.
    expect(
      isHelpRequestOpen({ ...task, helpAskedForDue: DUE, nextDue: '2026-09-13T08:00:00.000Z' })
    ).toBe(false);
    expect(isHelpRequestOpen(task)).toBe(false);
  });
});

describe('AskFamilyButton', () => {
  it('offers the ask on an unassigned task', async () => {
    const onAsk = vi.fn();
    render(<AskFamilyButton task={task} onAsk={onAsk} isPending={false} />);
    await userEvent.click(screen.getByRole('button', { name: /monstera/i }));
    expect(onAsk).toHaveBeenCalledWith(task);
  });

  it('offers the ask on your OWN explicit claim — the alternative to a silent unclaim', () => {
    render(
      <AskFamilyButton
        task={{ ...task, assignedTo: 'helper', assignedToName: 'Sam' }}
        onAsk={vi.fn()}
        isPending={false}
      />
    );
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('offers the ask on an inherited assignment, which anyone may take over', () => {
    render(
      <AskFamilyButton
        task={{
          ...task,
          assignedTo: 'priya',
          assignedToName: 'Priya',
          assignmentSource: 'rotation',
        }}
        onAsk={vi.fn()}
        isPending={false}
      />
    );
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('hides the ask on someone else’s explicit claim — theirs to release', () => {
    render(
      <AskFamilyButton
        task={{ ...task, assignedTo: 'priya', assignedToName: 'Priya', assignmentSource: null }}
        onAsk={vi.fn()}
        isPending={false}
      />
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('hides the ask once one is already open on the occurrence', () => {
    render(
      <AskFamilyButton task={{ ...task, helpAskedForDue: DUE }} onAsk={vi.fn()} isPending={false} />
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('AskedForHelpBadge', () => {
  it('names the asker and shows their note to whoever sees the row', () => {
    render(<AskedForHelpBadge name="Priya" note="I’m travelling until Sunday" />);
    expect(screen.getByText(/priya asked the family/i)).toBeInTheDocument();
    expect(screen.getByText(/travelling until sunday/i)).toBeInTheDocument();
  });

  it('still says an ask is open when the asker’s name is missing, and shows no empty quote', () => {
    render(<AskedForHelpBadge name={null} note={null} />);
    expect(screen.getByText(/asked the family/i)).toBeInTheDocument();
    expect(screen.queryByText('“”')).not.toBeInTheDocument();
  });
});

describe('AskFamilyDialog', () => {
  it('sends the typed note and starts empty again on the next ask', async () => {
    const onConfirm = vi.fn();
    const { rerender } = render(
      <AskFamilyDialog
        isOpen
        plantName="Monstera"
        isPending={false}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />
    );

    await userEvent.type(screen.getByRole('textbox'), 'away until Sunday');
    await userEvent.click(screen.getByRole('button', { name: /ask the family/i }));
    expect(onConfirm).toHaveBeenCalledWith('away until Sunday');

    // A previous task's reason must never ride along on the next ask.
    rerender(
      <AskFamilyDialog
        isOpen={false}
        plantName="Monstera"
        isPending={false}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />
    );
    rerender(
      <AskFamilyDialog
        isOpen
        plantName="Fiddle Leaf"
        isPending={false}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />
    );
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  it('lets the ask go out with no note at all', async () => {
    const onConfirm = vi.fn();
    render(
      <AskFamilyDialog
        isOpen
        plantName="Monstera"
        isPending={false}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: /ask the family/i }));
    expect(onConfirm).toHaveBeenCalledWith('');
  });
});
