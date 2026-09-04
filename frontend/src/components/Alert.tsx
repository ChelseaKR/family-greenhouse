import { ReactNode } from 'react';
import {
  CheckCircleIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  XCircleIcon,
} from '@heroicons/react/24/outline';
import clsx from 'clsx';

type AlertVariant = 'success' | 'error' | 'warning' | 'info';

/**
 * How this alert interrupts.
 *
 *   - `assertive` — `role="alert"`. Cuts off whatever the screen reader is
 *     currently saying, mid-word. Right for an unexpected failure the user
 *     must know about before they act again; wrong for anything that merely
 *     appeared because a query resolved.
 *   - `polite`    — `role="status"`. Queued behind whatever is being read.
 *   - `off`       — no role, no live region. For an alert that renders INSIDE
 *     a live region its parent already owns: two nested regions announce
 *     twice, and an assertive child defeats a polite parent entirely.
 */
export type AlertLive = 'assertive' | 'polite' | 'off';

interface AlertProps {
  variant: AlertVariant;
  title?: string;
  children: ReactNode;
  className?: string;
  /**
   * Overrides the per-variant default below. Pass `assertive` for the rare
   * non-error that genuinely must interrupt, and `off` inside a live region
   * the surrounding page already declares.
   */
  live?: AlertLive;
}

/**
 * Politeness by variant, because the component cannot tell an urgent error
 * from a paragraph of care advice any other way.
 *
 * `error` interrupts: it is unexpected, it usually means the user's last
 * action did not happen, and it is worth cutting a sentence short for.
 * Everything else is queued. Most of this component's uses are static
 * informational content that mounts when a query settles — a seasonal move
 * suggestion, a toxicity note, an import summary — and every one of those used
 * to interrupt whatever the user was reading at the moment the query returned.
 */
const DEFAULT_LIVE: Record<AlertVariant, AlertLive> = {
  error: 'assertive',
  warning: 'polite',
  info: 'polite',
  success: 'polite',
};

const LIVE_ROLE: Record<AlertLive, 'alert' | 'status' | undefined> = {
  assertive: 'alert',
  polite: 'status',
  off: undefined,
};

const variantConfig = {
  success: {
    icon: CheckCircleIcon,
    bgClass: 'bg-green-50',
    textClass: 'text-green-800',
    iconClass: 'text-green-400',
  },
  error: {
    icon: XCircleIcon,
    bgClass: 'bg-red-50',
    textClass: 'text-red-800',
    iconClass: 'text-red-400',
  },
  warning: {
    icon: ExclamationTriangleIcon,
    bgClass: 'bg-yellow-50',
    textClass: 'text-yellow-800',
    iconClass: 'text-yellow-400',
  },
  info: {
    icon: InformationCircleIcon,
    bgClass: 'bg-blue-50',
    textClass: 'text-blue-800',
    iconClass: 'text-blue-400',
  },
};

export function Alert({ variant, title, children, className, live }: AlertProps) {
  const config = variantConfig[variant];
  const Icon = config.icon;
  const role = LIVE_ROLE[live ?? DEFAULT_LIVE[variant]];

  return (
    <div className={clsx('rounded-md p-4', config.bgClass, className)} role={role}>
      <div className="flex">
        <div className="shrink-0">
          <Icon className={clsx('h-5 w-5', config.iconClass)} aria-hidden="true" />
        </div>
        <div className="ml-3">
          {title && <h3 className={clsx('text-sm font-medium', config.textClass)}>{title}</h3>}
          <div className={clsx('text-sm', config.textClass, title && 'mt-2')}>{children}</div>
        </div>
      </div>
    </div>
  );
}
