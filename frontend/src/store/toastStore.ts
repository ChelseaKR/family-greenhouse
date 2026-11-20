import { create } from 'zustand';

export type ToastVariant = 'success' | 'error' | 'info';

/**
 * One optional follow-up a toast can offer — "Undo" after moving a plant to
 * the trash (#670). Choosing it runs `onAction` and dismisses the toast. The
 * action must never be the ONLY way to reach its outcome: a toast times out,
 * and a screen-reader or keyboard user may not get to it in time, so every
 * caller keeps a durable route to the same thing (Settings → Trash here).
 */
export interface ToastAction {
  label: string;
  onAction: () => void;
}

export interface Toast {
  id: number;
  variant: ToastVariant;
  message: string;
  action?: ToastAction;
}

export interface ToastOptions {
  action?: ToastAction;
  /** How long it stays, when it must end with something else (an Undo
   *  window): the default lengths below otherwise. */
  durationMs?: number;
}

interface ToastState {
  toasts: Toast[];
  /** Shows a toast and answers its id, for `dismiss`. */
  add: (variant: ToastVariant, message: string, options?: ToastOptions) => number;
  dismiss: (id: number) => void;
  /**
   * Stop a toast's clock while the pointer is over it or focus is inside it,
   * and restart it with the time it had left once neither is true. A toast
   * that vanished under the pointer took a sentence half-read with it, and one
   * that vanished while its Undo button had keyboard focus dropped focus to the
   * top of the page (WCAG 2.2.1 Timing Adjustable, 2.4.3 Focus Order).
   */
  hold: (id: number, reason: HoldReason) => void;
  release: (id: number, reason: HoldReason) => void;
}

export type HoldReason = 'pointer' | 'focus';

interface Clock {
  handle: ReturnType<typeof setTimeout> | undefined;
  remainingMs: number;
  startedAt: number;
  holds: Set<HoldReason>;
}

/** One clock per toast on screen, outside the React state: nothing renders
 *  from it, and it must not cause a render when it ticks. */
const clocks = new Map<number, Clock>();

// Module-level counter for stable keys (avoids Math.random/Date collisions and
// keeps ids deterministic across renders).
let nextId = 0;
const DURATION_MS: Record<ToastVariant, number> = {
  // Errors linger a little longer so they stay readable.
  error: 6000,
  success: 4000,
  info: 4000,
};
/** A toast with an action stays long enough to read AND reach the button. */
const ACTION_DURATION_MS = 10_000;

export const useToastStore = create<ToastState>((set) => {
  const remove = (id: number) => {
    const clock = clocks.get(id);
    if (clock?.handle !== undefined) clearTimeout(clock.handle);
    clocks.delete(id);
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  };
  const run = (id: number) => {
    const clock = clocks.get(id);
    if (!clock || clock.handle !== undefined || clock.holds.size > 0) return;
    clock.startedAt = Date.now();
    clock.handle = setTimeout(() => remove(id), clock.remainingMs);
  };
  return {
    toasts: [],
    add: (variant, message, options) => {
      const id = nextId++;
      const action = options?.action;
      set((s) => ({
        toasts: [...s.toasts, { id, variant, message, ...(action ? { action } : {}) }],
      }));
      if (typeof window !== 'undefined') {
        clocks.set(id, {
          handle: undefined,
          remainingMs: options?.durationMs ?? (action ? ACTION_DURATION_MS : DURATION_MS[variant]),
          startedAt: 0,
          holds: new Set(),
        });
        run(id);
      }
      return id;
    },
    dismiss: remove,
    hold: (id, reason) => {
      const clock = clocks.get(id);
      if (!clock) return;
      clock.holds.add(reason);
      if (clock.handle === undefined) return;
      clearTimeout(clock.handle);
      clock.handle = undefined;
      clock.remainingMs = Math.max(0, clock.remainingMs - (Date.now() - clock.startedAt));
    },
    release: (id, reason) => {
      const clock = clocks.get(id);
      if (!clock) return;
      clock.holds.delete(reason);
      run(id);
    },
  };
});

/**
 * Imperative helper so non-component code (mutation callbacks, services) can
 * fire a toast without a hook — mirrors the `toast.success(...)` ergonomics of
 * libraries like sonner, but with zero added bundle weight (we already ship
 * zustand). Render <Toaster /> once near the app root to display them.
 */
export const toast = {
  success: (message: string, options?: ToastOptions) =>
    useToastStore.getState().add('success', message, options),
  error: (message: string, options?: ToastOptions) =>
    useToastStore.getState().add('error', message, options),
  info: (message: string, options?: ToastOptions) =>
    useToastStore.getState().add('info', message, options),
};
