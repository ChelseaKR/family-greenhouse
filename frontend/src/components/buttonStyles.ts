import clsx from 'clsx';

export type ButtonVariant = 'primary' | 'secondary' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

// min-h-touch + min-w-touch guarantee a 44×44 CSS-px target (WCAG 2.5.5
// AAA) for both buttons and links; sizes tune padding/text on top of that floor.
const baseClasses =
  'inline-flex items-center justify-center whitespace-nowrap font-medium rounded-lg transition-[color,background-color,border-color,box-shadow,transform] min-h-touch min-w-touch focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed active:translate-y-px';

const variantClasses: Record<ButtonVariant, string> = {
  // primary-700 + white clears WCAG AA contrast (5:1); primary-600 was 3.76.
  primary:
    'bg-primary-700 text-white shadow-[0_8px_20px_-14px_rgba(23,52,4,0.9)] hover:bg-primary-800 hover:shadow-[0_12px_24px_-14px_rgba(23,52,4,0.95)] focus-visible:ring-primary-500',
  secondary:
    'bg-paper/85 text-ink border border-dew hover:bg-glass/55 focus-visible:ring-primary-500',
  danger: 'bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-500',
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'px-3 py-1.5 text-sm',
  md: 'px-4 py-2 text-sm',
  lg: 'px-6 py-3 text-base min-h-[52px]',
};

/** Shared visual treatment for links that act as navigation buttons. */
export function buttonStyles({
  variant = 'primary',
  size = 'md',
  className,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
} = {}) {
  return clsx(baseClasses, variantClasses[variant], sizeClasses[size], className);
}
