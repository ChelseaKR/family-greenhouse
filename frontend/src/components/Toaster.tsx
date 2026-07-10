import { createPortal } from 'react-dom';
import {
  CheckCircleIcon,
  XCircleIcon,
  InformationCircleIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import clsx from 'clsx';
import { useToastStore, type ToastVariant } from '@/store/toastStore';

const variantConfig: Record<
  ToastVariant,
  { icon: typeof CheckCircleIcon; bg: string; text: string; iconColor: string }
> = {
  success: {
    icon: CheckCircleIcon,
    bg: 'bg-green-50 ring-green-200/70',
    text: 'text-green-900',
    iconColor: 'text-green-600',
  },
  error: {
    icon: XCircleIcon,
    bg: 'bg-red-50 ring-red-200/70',
    text: 'text-red-900',
    iconColor: 'text-red-600',
  },
  info: {
    icon: InformationCircleIcon,
    bg: 'bg-sky-50 ring-sky-200/70',
    text: 'text-sky-900',
    iconColor: 'text-sky-600',
  },
};

/**
 * Transient notification stack. Mount once near the app root. The container is
 * a persistent polite live region so screen readers announce toasts as they're
 * inserted; each toast also has a dismiss button for keyboard/AT users since
 * auto-dismiss alone isn't accessible.
 */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2"
      role="region"
      aria-label="Notifications"
      aria-live="polite"
    >
      {toasts.map((t) => {
        const c = variantConfig[t.variant];
        const Icon = c.icon;
        return (
          <div
            key={t.id}
            className={clsx(
              'pointer-events-auto flex items-start gap-3 rounded-md p-4 shadow-lg ring-1',
              c.bg
            )}
          >
            <Icon className={clsx('h-5 w-5 flex-shrink-0', c.iconColor)} aria-hidden="true" />
            <p className={clsx('flex-1 text-sm', c.text)}>{t.message}</p>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss notification"
              className={clsx(
                'inline-flex min-h-touch min-w-touch flex-shrink-0 items-center justify-center rounded opacity-70 transition-opacity hover:opacity-100',
                'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
                c.text
              )}
            >
              <XMarkIcon className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>,
    document.body
  );
}
