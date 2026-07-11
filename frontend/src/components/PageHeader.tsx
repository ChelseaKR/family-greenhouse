import { ReactNode } from 'react';
import clsx from 'clsx';
import { TitleUnderline } from './brand/TitleUnderline';

/**
 * Authenticated-page header. The Gloock serif title gets a hand-drawn
 * underline underneath; an optional eyebrow line floats above; an optional
 * piece of illustration art tucks into the top-right.
 *
 * Used by Dashboard, Plants, Tasks, etc., as the canonical "this is the
 * top of the page" element. Replaces the bare `<h1 className="text-2xl">`
 * pattern that the auth pages all inherited from the dashboard.
 */
interface PageHeaderProps {
  /** Small label above the title, e.g. "Your household". */
  eyebrow?: string;
  /** The page title — rendered in Gloock serif. */
  title: string;
  /** Secondary line below the title. */
  description?: ReactNode;
  /** Right-aligned action(s) — primary CTA + secondary, etc. */
  action?: ReactNode;
  /** Optional botanical illustration that sits at the right of the header. */
  art?: ReactNode;
  className?: string;
}

export function PageHeader({
  eyebrow,
  title,
  description,
  action,
  art,
  className,
}: PageHeaderProps) {
  return (
    <header className={clsx('mb-8', className)}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="flex-1 min-w-0">
          {/* Eyebrow uses full-strength primary-700 — an /opacity modifier
              blends it into the paper background and drops small-text
              contrast below WCAG AA (4.5:1). */}
          {eyebrow && (
            <p className="text-xs uppercase tracking-[0.18em] text-primary-700 font-semibold mb-2">
              {eyebrow}
            </p>
          )}
          <h1 className="font-serif text-3xl sm:text-4xl text-ink leading-tight tracking-tight">
            {title}
          </h1>
          <TitleUnderline className="mt-1 ml-1 h-3 w-28 sm:w-36 md:w-44 text-primary-600" />
          {description && (
            <p className="mt-3 text-sm sm:text-base text-gray-600 max-w-2xl">{description}</p>
          )}
        </div>
        {art && <div className="hidden w-48 flex-shrink-0 sm:block lg:w-56">{art}</div>}
        {action && !art && <div className="w-full flex-shrink-0 sm:w-auto">{action}</div>}
      </div>
      {action && art && <div className="mt-4 flex justify-end">{action}</div>}
    </header>
  );
}
