import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toaster } from '@/components/Toaster';
import { toast, useToastStore } from '@/store/toastStore';

/**
 * The toast action exists for one job — "Undo" after moving a plant to the
 * trash (#670) — and three things about it are load-bearing: the button is a
 * real, named control; choosing it runs the action exactly once and dismisses
 * the toast; and an actionable toast stays up long enough to reach it.
 */
describe('Toaster actions', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the action as a button that runs once and dismisses the toast', async () => {
    const onAction = vi.fn();
    render(<Toaster />);
    act(() => {
      toast.success('Moved “Fern” to the trash', { action: { label: 'Undo', onAction } });
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Undo' }));

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Moved “Fern” to the trash')).not.toBeInTheDocument();
  });

  it('keeps a toast without an action free of an extra button', async () => {
    render(<Toaster />);
    act(() => {
      toast.info('Task snoozed');
    });
    expect(await screen.findByText('Task snoozed')).toBeInTheDocument();
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Dismiss notification',
    ]);
  });

  it('holds an actionable toast longer than a plain one', () => {
    vi.useFakeTimers();
    toast.success('plain');
    toast.success('with undo', { action: { label: 'Undo', onAction: () => {} } });
    vi.advanceTimersByTime(4_001);
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(['with undo']);
    vi.advanceTimersByTime(6_000);
    expect(useToastStore.getState().toasts).toEqual([]);
  });
});
