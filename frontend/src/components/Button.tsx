import { forwardRef, ButtonHTMLAttributes } from 'react';
import { useTranslation } from 'react-i18next';
import { LoadingSpinner } from './LoadingSpinner';
import { buttonStyles, type ButtonSize, type ButtonVariant } from './buttonStyles';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
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
      onClick,
      ...props
    },
    ref
  ) => {
    const { t } = useTranslation();
    return (
      <button
        ref={ref}
        className={buttonStyles({ variant, size, className })}
        // While loading the button is aria-disabled, not disabled. A disabled
        // button cannot hold focus, and Chromium moves focus to the document
        // when the focused control becomes disabled: someone who pressed Save
        // with the keyboard was back at the top of the page by the time the
        // request returned, on every async button in the app (WCAG 2.4.3). A
        // screen reader still hears "unavailable, busy", and the click is
        // refused here, which also stops a submit button submitting twice.
        disabled={disabled}
        aria-disabled={isLoading || undefined}
        aria-busy={isLoading || undefined}
        onClick={isLoading ? (event) => event.preventDefault() : onClick}
        {...props}
      >
        {isLoading ? (
          <>
            <LoadingSpinner size="sm" className="mr-2" />
            <span>{t('common.loadingDots')}</span>
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
