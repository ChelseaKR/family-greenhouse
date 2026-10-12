import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  UNDO_WINDOW_MS,
  createDeferredCareQueue,
  deferredCareQueue,
  resetDeferredCareQueueForTests,
  type PendingCare,
} from '@/features/plants/deferredCare';

const item = (taskId: string): PendingCare => ({
  taskId,
  plantId: `p-${taskId}`,
  expectedNextDue: '2026-10-03T23:00:00.000Z',
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the deferred completion queue', () => {
  it('commits once, after the window, and not before', () => {
    const queue = createDeferredCareQueue();
    const commit = vi.fn();
    expect(queue.schedule(item('t1'), commit)).toBe(true);
    vi.advanceTimersByTime(UNDO_WINDOW_MS - 1);
    expect(commit).not.toHaveBeenCalled();
    expect(queue.pending().has('t1')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(item('t1'));
    vi.advanceTimersByTime(UNDO_WINDOW_MS * 3);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(queue.pending().has('t1')).toBe(false);
  });

  it('an undo inside the window commits nothing, ever', () => {
    const queue = createDeferredCareQueue();
    const commit = vi.fn();
    queue.schedule(item('t1'), commit);
    vi.advanceTimersByTime(UNDO_WINDOW_MS - 10);
    expect(queue.undo('t1')).toBe(true);
    vi.advanceTimersByTime(UNDO_WINDOW_MS * 3);
    queue.flush();
    expect(commit).not.toHaveBeenCalled();
    expect(queue.pending().size).toBe(0);
  });

  it('an undo after the commit is refused (too late), and does not commit again', () => {
    const queue = createDeferredCareQueue();
    const commit = vi.fn();
    queue.schedule(item('t1'), commit);
    vi.advanceTimersByTime(UNDO_WINDOW_MS);
    expect(queue.undo('t1')).toBe(false);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('refuses a second completion for a task that is already pending', () => {
    const queue = createDeferredCareQueue();
    const first = vi.fn();
    const second = vi.fn();
    expect(queue.schedule(item('t1'), first)).toBe(true);
    expect(queue.schedule(item('t1'), second)).toBe(false);
    vi.advanceTimersByTime(UNDO_WINDOW_MS);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('flush commits every waiting completion now, exactly once', () => {
    const queue = createDeferredCareQueue();
    const commit = vi.fn();
    queue.schedule(item('t1'), commit);
    queue.schedule(item('t2'), commit);
    queue.schedule(item('t3'), commit);
    queue.undo('t2');
    queue.flush();
    expect(commit.mock.calls.map(([i]) => i.taskId)).toEqual(['t1', 't3']);
    queue.flush();
    vi.advanceTimersByTime(UNDO_WINDOW_MS * 2);
    expect(commit).toHaveBeenCalledTimes(2);
  });

  it('after a commit the same task can be scheduled again (its next occurrence)', () => {
    const queue = createDeferredCareQueue();
    const commit = vi.fn();
    queue.schedule(item('t1'), commit);
    vi.advanceTimersByTime(UNDO_WINDOW_MS);
    expect(queue.schedule(item('t1'), commit)).toBe(true);
  });

  it('tells subscribers when the pending set changes', () => {
    const queue = createDeferredCareQueue();
    const seen: string[][] = [];
    queue.subscribe(() => seen.push([...queue.pending()]));
    queue.schedule(item('t1'), vi.fn());
    queue.undo('t1');
    expect(seen).toEqual([['t1'], []]);
  });
});

describe('the shared queue', () => {
  afterEach(() => resetDeferredCareQueueForTests());

  it('commits everything at once when the page is hidden (the app goes to the background)', () => {
    resetDeferredCareQueueForTests();
    const queue = deferredCareQueue();
    const commit = vi.fn();
    queue.schedule(item('t1'), commit);
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    visibility.mockRestore();
    expect(commit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(UNDO_WINDOW_MS * 2);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('commits on pagehide (a reload or a closed tab)', () => {
    resetDeferredCareQueueForTests();
    const queue = deferredCareQueue();
    const commit = vi.fn();
    queue.schedule(item('t9'), commit);
    window.dispatchEvent(new Event('pagehide'));
    expect(commit).toHaveBeenCalledTimes(1);
  });
});
