import { forwardRef, ButtonHTMLAttributes } from 'react';
import clsx from 'clsx';
import { LoadingSpinner } from './LoadingSpinner';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  isLoading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      isLoading = false,
      leftIcon,
      rightIcon,
      children,
      className,
      disabled,
      ...props
    },
    ref
  ) => {
    // min-h-touch + min-w-touch guarantee a 44×44 CSS-px target (WCAG 2.5.5
    // AAA) for every button, including icon-only ones; sizes tune padding/text
    // on top of that floor.
    const baseClasses =
      'inline-flex items-center justify-center font-medium rounded-md transition-colors min-h-touch min-w-touch focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed';

    const variantClasses = {
      // primary-700 + white clears WCAG AA contrast (5:1); primary-600 was 3.76.
      primary: 'bg-primary-700 text-white hover:bg-primary-800 focus-visible:ring-primary-500',
      secondary:
        'bg-white text-gray-700 border border-gray-300 hover:bg-gray-50 focus-visible:ring-primary-500',
      danger: 'bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-500',
    };

    const sizeClasses = {
      sm: 'px-3 py-1.5 text-sm',
      md: 'px-4 py-2 text-sm',
      lg: 'px-6 py-3 text-base min-h-[52px]',
    };

    return (
      <button
        ref={ref}
        className={clsx(baseClasses, variantClasses[variant], sizeClasses[size], className)}
        disabled={disabled || isLoading}
        {...props}
      >
        {isLoading ? (
          <>
            <LoadingSpinner size="sm" className="mr-2" />
            <span>Loading...</span>
          </>
        ) : (
          <>
            {leftIcon && <span className="mr-2">{leftIcon}</span>}
            {children}
            {rightIcon && <span className="ml-2">{rightIcon}</span>}
          </>
        )}
      </button>
    );
  }
);

Button.displayName = 'Button';
