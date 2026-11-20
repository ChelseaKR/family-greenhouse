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

  it('ends a toast when its own duration says, and answers its id for dismiss', () => {
    vi.useFakeTimers();
    try {
      const id = toast.success('Done: Water, Fern', {
        durationMs: 5000,
        action: { label: 'Undo', onAction: () => undefined },
      });
      expect(useToastStore.getState().toasts.map((t) => t.id)).toEqual([id]);
      vi.advanceTimersByTime(4999);
      expect(useToastStore.getState().toasts).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(useToastStore.getState().toasts).toHaveLength(0);
      const second = toast.info('Snoozed');
      useToastStore.getState().dismiss(second);
      expect(useToastStore.getState().toasts).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays up while its Undo button has keyboard focus, and ends after focus leaves', async () => {
    // A toast that timed out under a focused Undo button dropped focus to the
    // top of the page (WCAG 2.4.3) and cut short the time to act (2.2.1).
    vi.useFakeTimers();
    render(<Toaster />);
    act(() => {
      toast.success('Moved “Fern” to the trash', {
        action: { label: 'Undo', onAction: vi.fn() },
      });
    });
    const undo = screen.getByRole('button', { name: 'Undo' });
    act(() => undo.focus());
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText('Moved “Fern” to the trash')).toBeInTheDocument();
    expect(undo).toHaveFocus();

    act(() => undo.blur());
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.queryByText('Moved “Fern” to the trash')).not.toBeInTheDocument();
  });

  it('stays up while the pointer is over it', () => {
    vi.useFakeTimers();
    render(<Toaster />);
    act(() => {
      toast.info('Task snoozed');
    });
    const message = screen.getByText('Task snoozed');
    const card = message.parentElement!;
    act(() => {
      card.dispatchEvent(new MouseEvent('mouseenter'));
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText('Task snoozed')).toBeInTheDocument();
    act(() => {
      card.dispatchEvent(new MouseEvent('mouseleave'));
      vi.advanceTimersByTime(4000);
    });
    expect(screen.queryByText('Task snoozed')).not.toBeInTheDocument();
  });
});
