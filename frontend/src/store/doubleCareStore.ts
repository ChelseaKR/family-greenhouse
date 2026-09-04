import { create } from 'zustand';
import type { DuplicateCareDetails } from '@/features/tasks/doubleCare';

/**
 * A completion the server held back as suspected double-care, waiting for
 * the member's explicit "log it anyway". One at a time: the prompt is a
 * modal, and the mutation that raised it has already rolled back its
 * optimistic patch, so nothing is in limbo while it waits.
 */
export interface PendingDuplicate {
  taskId: string;
  expectedNextDue: string;
  details: DuplicateCareDetails;
}

interface DoubleCareState {
  pending: PendingDuplicate | null;
  prompt: (pending: PendingDuplicate) => void;
  clear: () => void;
}

export const useDoubleCareStore = create<DoubleCareState>((set) => ({
  pending: null,
  prompt: (pending) => set({ pending }),
  clear: () => set({ pending: null }),
}));
