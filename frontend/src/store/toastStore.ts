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
}

interface ToastState {
  toasts: Toast[];
  add: (variant: ToastVariant, message: string, options?: ToastOptions) => void;
  dismiss: (id: number) => void;
}

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

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  add: (variant, message, options) => {
    const id = nextId++;
    const action = options?.action;
    set((s) => ({
      toasts: [...s.toasts, { id, variant, message, ...(action ? { action } : {}) }],
    }));
    if (typeof window !== 'undefined') {
      window.setTimeout(
        () => {
          set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
        },
        action ? ACTION_DURATION_MS : DURATION_MS[variant]
      );
    }
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

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
