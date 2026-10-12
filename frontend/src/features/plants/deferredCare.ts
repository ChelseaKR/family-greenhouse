/**
 * A completion that waits out an Undo window before it is written.
 *
 * Marking a task done from the Plants list (the Water button, a full swipe,
 * "Water now" in the row's menu) does not call the API at once. It waits
 * `UNDO_WINDOW_MS`; Undo inside that window cancels it and NOTHING is sent.
 * There is no API to take a completion back, so the window is the only undo
 * there is, and this file is what makes it hold:
 *
 * - One pending completion per task. A second request for the same task
 *   while one is pending is refused, so a double tap, a swipe after a tap, or
 *   the menu after the button can never complete a task twice.
 * - Each pending completion is committed AT MOST ONCE: its state moves
 *   waiting -> committing exactly once, from the timer, from `flush`, or not
 *   at all if it was undone first. Undo after the commit started is refused.
 * - The queue is a module singleton, not component state: leaving the
 *   Plants page does not drop or duplicate a pending completion, the timer
 *   still fires.
 * - When the page is hidden (the app goes to the background, the tab is
 *   closed or reloaded), every pending completion is committed at once
 *   (`flush`): the person meant it, and a timer in a suspended web view may
 *   never fire. If that request then fails, the mutation's own error path
 *   reports it; nothing is retried behind anyone's back.
 */
export const UNDO_WINDOW_MS = 5000;

export interface PendingCare {
  taskId: string;
  plantId: string;
  /** Sent with the completion so a transport retry stays idempotent. */
  expectedNextDue: string;
}

type State = 'waiting' | 'committing';

interface Entry {
  item: PendingCare;
  state: State;
  timer: ReturnType<typeof setTimeout> | null;
  commit: (item: PendingCare) => void;
}

type Listener = () => void;

export interface DeferredCareQueue {
  /** Starts the window. False when this task already has one pending. */
  schedule(item: PendingCare, commit: (item: PendingCare) => void): boolean;
  /** Cancels a waiting completion. False when there is none, or it already
   *  started committing (too late to undo). */
  undo(taskId: string): boolean;
  /** Commits every waiting completion now. */
  flush(): void;
  /** Task ids still inside their window. */
  pending(): ReadonlySet<string>;
  subscribe(listener: Listener): () => void;
}

export function createDeferredCareQueue(windowMs = UNDO_WINDOW_MS): DeferredCareQueue {
  const entries = new Map<string, Entry>();
  const listeners = new Set<Listener>();
  let snapshot: ReadonlySet<string> = new Set();

  const changed = () => {
    snapshot = new Set([...entries].filter(([, e]) => e.state === 'waiting').map(([id]) => id));
    for (const listener of listeners) listener();
  };

  const commitNow = (taskId: string) => {
    const entry = entries.get(taskId);
    if (!entry || entry.state !== 'waiting') return;
    entry.state = 'committing';
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = null;
    // Forget it before calling out: the commit may schedule this task again
    // (the next occurrence) and that must be a fresh entry.
    entries.delete(taskId);
    changed();
    entry.commit(entry.item);
  };

  return {
    schedule(item, commit) {
      if (entries.has(item.taskId)) return false;
      const entry: Entry = { item, state: 'waiting', timer: null, commit };
      entries.set(item.taskId, entry);
      entry.timer = setTimeout(() => commitNow(item.taskId), windowMs);
      changed();
      return true;
    },
    undo(taskId) {
      const entry = entries.get(taskId);
      if (!entry || entry.state !== 'waiting') return false;
      if (entry.timer !== null) clearTimeout(entry.timer);
      entries.delete(taskId);
      changed();
      return true;
    },
    flush() {
      for (const taskId of [...entries.keys()]) commitNow(taskId);
    },
    pending: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

let shared: DeferredCareQueue | null = null;

/** The app's one queue, created on first use; flushed when the page hides. */
export function deferredCareQueue(): DeferredCareQueue {
  if (shared) return shared;
  const queue = createDeferredCareQueue();
  shared = queue;
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') queue.flush();
    });
    window.addEventListener('pagehide', () => queue.flush());
  }
  return queue;
}

/** Tests only: forget the shared queue (its listeners stay harmless). */
export function resetDeferredCareQueueForTests(): void {
  shared = null;
}
