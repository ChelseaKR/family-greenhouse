import { create } from 'zustand';

export type ToastVariant = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  variant: ToastVariant;
  message: string;
}

interface ToastState {
  toasts: Toast[];
  add: (variant: ToastVariant, message: string) => void;
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

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  add: (variant, message) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, variant, message }] }));
    if (typeof window !== 'undefined') {
      window.setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
      }, DURATION_MS[variant]);
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
  success: (message: string) => useToastStore.getState().add('success', message),
  error: (message: string) => useToastStore.getState().add('error', message),
  info: (message: string) => useToastStore.getState().add('info', message),
};
