import { useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import {
  CheckCircleIcon,
  XCircleIcon,
  InformationCircleIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import { useToastStore, type HoldReason, type ToastVariant } from '@/store/toastStore';

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

const noopSubscribe = () => () => {};

/**
 * A ref callback that stops a toast's clock while the pointer is over it or
 * focus is inside it, so it cannot vanish mid-sentence or from under a focused
 * Undo button (WCAG 2.2.1, 2.4.3). Native listeners rather than JSX handlers:
 * the toast is not itself a control, and must not be announced as one.
 */
function holdWhileInUse(
  id: number,
  hold: (id: number, reason: HoldReason) => void,
  release: (id: number, reason: HoldReason) => void
) {
  return (el: HTMLDivElement | null) => {
    if (!el) return;
    const onEnter = () => hold(id, 'pointer');
    const onLeave = () => release(id, 'pointer');
    const onFocusIn = () => hold(id, 'focus');
    const onFocusOut = (e: FocusEvent) => {
      if (!el.contains(e.relatedTarget as Node | null)) release(id, 'focus');
    };
    el.addEventListener('mouseenter', onEnter);
    el.addEventListener('mouseleave', onLeave);
    el.addEventListener('focusin', onFocusIn);
    el.addEventListener('focusout', onFocusOut);
    return () => {
      el.removeEventListener('mouseenter', onEnter);
      el.removeEventListener('mouseleave', onLeave);
      el.removeEventListener('focusin', onFocusIn);
      el.removeEventListener('focusout', onFocusOut);
    };
  };
}

/**
 * False during server rendering AND during the client's hydration render, true
 * from the first commit onward.
 *
 * `useSyncExternalStore`'s third argument is the server snapshot, and React
 * uses it for the hydration render too — which is exactly the guarantee needed
 * here. The previous `typeof document === 'undefined'` check did NOT give that:
 * it made the server render nothing while the client's very first render
 * produced a portal, so React saw the tree change shape underneath it, reported
 * a hydration mismatch, and threw away the entire prerendered page. Every
 * marketing route would have shipped real HTML to crawlers and then re-rendered
 * from scratch in every real browser.
 *
 * Same idiom as `useHeroVariant` in lib/experiment.ts.
 */
function useIsHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false
  );
}

/**
 * Transient notification stack. Mount once near the app root. The container is
 * a persistent polite live region so screen readers announce toasts as they're
 * inserted; each toast also has a dismiss button for keyboard/AT users since
 * auto-dismiss alone isn't accessible.
 */
export function Toaster() {
  // `translate`, not `t`: the toast being drawn is called `t` below.
  const { t: translate } = useTranslation();
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  const hold = useToastStore((s) => s.hold);
  const release = useToastStore((s) => s.release);
  const hydrated = useIsHydrated();

  // Nothing to portal into during the prerender, and nothing may be portalled
  // during hydration either — see useIsHydrated. Toasts are only ever raised by
  // user action, so there is nothing to show this early regardless.
  if (!hydrated || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="pointer-events-none fixed right-4 bottom-[max(1rem,calc(env(safe-area-inset-bottom)+0.5rem))] left-4 z-50 native-frame:bottom-[calc(env(safe-area-inset-bottom)+0.75rem)]! ml-auto flex max-w-sm flex-col gap-2 sm:left-auto sm:w-full"
      role="region"
      aria-label={translate('notifications.title')}
      aria-live="polite"
    >
      {toasts.map((t) => {
        const c = variantConfig[t.variant];
        const Icon = c.icon;
        return (
          <div
            key={t.id}
            ref={holdWhileInUse(t.id, hold, release)}
            className={clsx(
              'pointer-events-auto flex items-start gap-3 rounded-md p-4 shadow-lg ring-1',
              c.bg
            )}
          >
            <Icon className={clsx('h-5 w-5 shrink-0', c.iconColor)} aria-hidden="true" />
            <p className={clsx('flex-1 text-sm', c.text)}>{t.message}</p>
            {t.action && (
              <button
                type="button"
                onClick={() => {
                  const { onAction } = t.action!;
                  dismiss(t.id);
                  onAction();
                }}
                className={clsx(
                  'inline-flex min-h-touch shrink-0 items-center justify-center rounded-sm px-2 text-sm font-semibold underline underline-offset-2',
                  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
                  c.text
                )}
              >
                {t.action.label}
              </button>
            )}
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label={translate('toasts.dismiss')}
              className={clsx(
                'inline-flex min-h-touch min-w-touch shrink-0 items-center justify-center rounded-sm opacity-70 transition-opacity hover:opacity-100',
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
