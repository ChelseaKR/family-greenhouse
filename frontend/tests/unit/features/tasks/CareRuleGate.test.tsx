import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { careRuleFor, useCareRuleGate } from '@/features/tasks/useCareRuleGate';
import type { Task } from '@/services/plantService';

const task: Task = {
  id: 't1',
  plantId: 'p1',
  plantName: 'Calathea',
  type: 'water',
  frequency: 7,
  lastCompleted: null,
  nextDue: '2099-01-01T00:00:00.000Z',
  assignedTo: null,
  assignedToName: null,
  notes: null,
  createdBy: 'u1',
  createdAt: '',
};

function Harness({ rule, onConfirm }: { rule: string | null; onConfirm: (t: Task) => void }) {
  const gate = useCareRuleGate<Task>(() => rule, onConfirm);
  return (
    <>
      <button type="button" onClick={() => gate.request(task)}>
        Done
      </button>
      {gate.dialog}
    </>
  );
}

describe('careRuleFor', () => {
  it('returns the trimmed rule, and null for missing, blank, or whitespace-only values', () => {
    expect(careRuleFor({ careRule: '  Bottom-water only ' })).toBe('Bottom-water only');
    expect(careRuleFor({ careRule: null })).toBeNull();
    expect(careRuleFor({ careRule: '' })).toBeNull();
    expect(careRuleFor({ careRule: '   ' })).toBeNull();
    expect(careRuleFor({})).toBeNull();
    expect(careRuleFor(undefined)).toBeNull();
    expect(careRuleFor(null)).toBeNull();
  });
});

describe('useCareRuleGate', () => {
  it('shows the rule before the completion goes through, and completes only on confirm', async () => {
    const onConfirm = vi.fn();
    render(<Harness rule="Bottom-water only" onConfirm={onConfirm} />);

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Bottom-water only')).toBeInTheDocument();
    expect(screen.getByText('Before you mark Calathea done')).toBeInTheDocument();
    expect(screen.getByText('Water · House rule')).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Mark done' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(task);
  });

  it('cancel closes the rule without completing', async () => {
    const onConfirm = vi.fn();
    render(<Harness rule="Bottom-water only" onConfirm={onConfirm} />);

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('completes immediately with nothing shown when the plant has no rule (no placeholder nag)', () => {
    const onConfirm = vi.fn();
    render(<Harness rule={null} onConfirm={onConfirm} />);

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(task);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText(/House rule/)).not.toBeInTheDocument();
  });

  it('labels a custom task by its own name', async () => {
    const onConfirm = vi.fn();
    function CustomHarness() {
      const gate = useCareRuleGate<Task>(() => 'Wipe leaves with a damp cloth', onConfirm);
      return (
        <>
          <button
            type="button"
            onClick={() => gate.request({ ...task, type: 'custom', customType: 'Dust' })}
          >
            Done
          </button>
          {gate.dialog}
        </>
      );
    }
    render(<CustomHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByText('Dust · House rule')).toBeInTheDocument();
  });
});
