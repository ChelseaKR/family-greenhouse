import type { ReactNode } from 'react';
import { MinusIcon, PlusIcon } from '@heroicons/react/24/outline';

interface NumberStepperProps {
  /** The current value (NaN or out of range while being typed is fine). */
  value: number;
  min: number;
  max: number;
  /** A step to a new, in-range value. */
  onStep: (next: number) => void;
  /** Accessible names of the two buttons ("One day less", "One day more"). */
  decreaseLabel: string;
  increaseLabel: string;
  /** The field itself: the labelled number input, which stays typeable. */
  children: ReactNode;
}

/**
 * A number field with − and + beside it, like the iOS stepper: one tap per
 * step, and the field still takes a typed number. The buttons stop at the
 * range's ends.
 */
export function NumberStepper({
  value,
  min,
  max,
  onStep,
  decreaseLabel,
  increaseLabel,
  children,
}: NumberStepperProps) {
  const current = Number.isFinite(value) ? Math.round(value) : min;
  const step = (delta: number) => {
    const next = Math.min(max, Math.max(min, current + delta));
    if (next === value) return;
    onStep(next);
  };
  const button =
    'flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-primary-200 bg-paper text-primary-800 hover:bg-primary-50 disabled:opacity-40 disabled:hover:bg-paper';
  return (
    <div className="flex items-end gap-2">
      <button
        type="button"
        className={button}
        aria-label={decreaseLabel}
        disabled={Number.isFinite(value) && current <= min}
        onClick={() => step(-1)}
      >
        <MinusIcon className="h-5 w-5" aria-hidden="true" />
      </button>
      <div className="min-w-0 flex-1">{children}</div>
      <button
        type="button"
        className={button}
        aria-label={increaseLabel}
        disabled={Number.isFinite(value) && current >= max}
        onClick={() => step(1)}
      >
        <PlusIcon className="h-5 w-5" aria-hidden="true" />
      </button>
    </div>
  );
}
