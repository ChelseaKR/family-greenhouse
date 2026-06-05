import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { useToastStore, toast } from '@/store/toastStore';

describe('toastStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToastStore.setState({ toasts: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('adds a toast with the given variant and message', () => {
    toast.success('Saved');
    const { toasts } = useToastStore.getState();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ variant: 'success', message: 'Saved' });
  });

  it('assigns unique ids to successive toasts', () => {
    toast.success('one');
    toast.error('two');
    const ids = useToastStore.getState().toasts.map((t) => t.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('auto-dismisses a success toast after its duration', () => {
    toast.success('bye');
    expect(useToastStore.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(4000);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('keeps error toasts longer than success toasts', () => {
    toast.error('still here');
    vi.advanceTimersByTime(4000);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(2000);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('dismisses a specific toast by id', () => {
    toast.info('a');
    toast.info('b');
    const [first] = useToastStore.getState().toasts;
    useToastStore.getState().dismiss(first.id);
    const remaining = useToastStore.getState().toasts;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].message).toBe('b');
  });
});
