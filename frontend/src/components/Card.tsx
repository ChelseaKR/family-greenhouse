import { ReactNode } from 'react';
import clsx from 'clsx';

interface CardProps {
  children: ReactNode;
  className?: string;
  padding?: 'none' | 'sm' | 'md' | 'lg';
  /**
   * Visual treatment:
   *  - `solid` (default): the original white-with-green-tinted-shadow card.
   *    Best for data-dense surfaces (stat tiles, analytics tables).
   *  - `paper`: warm parchment background, no border, soft journal shadow.
   *    The default surface for content-led views (dashboard sections,
   *    plant detail pages). Reads as "a page in a notebook" rather than
   *    "a tile in a dashboard".
   *  - `journal`: same warm background as paper, no shadow, a single
   *    hand-drawn-feeling rule along the bottom. Stacks well in lists
   *    where each card is a discrete item but the whole stack should
   *    read as one journal page.
   */
  variant?: 'solid' | 'paper' | 'journal';
}

const PADDING_CLASSES = {
  none: '',
  sm: 'p-4',
  md: 'p-6',
  lg: 'p-8',
};

const VARIANT_CLASSES: Record<NonNullable<CardProps['variant']>, string> = {
  solid: 'bg-white rounded-lg shadow-card border border-primary-100/70',
  paper:
    'bg-paper rounded-xl shadow-journal hover:shadow-journal-hover transition-shadow duration-200 border border-primary-100/60',
  journal: 'bg-paper border-b border-primary-100/80 last:border-b-0 rounded-none',
};

export function Card({ children, className, padding = 'md', variant = 'solid' }: CardProps) {
  return (
    <div
      className={clsx(
        // `motion-safe:` keeps the entrance animation polite to users with
        // reduced-motion preferences.
        'motion-safe:animate-fade-in',
        VARIANT_CLASSES[variant],
        PADDING_CLASSES[padding],
        className
      )}
    >
      {children}
    </div>
  );
}

interface CardHeaderProps {
  title: string;
  description?: string;
  action?: ReactNode;
}

export function CardHeader({ title, description, action }: CardHeaderProps) {
  return (
    <div className="flex items-start justify-between mb-4">
      <div>
        <h2 className="font-serif text-lg text-ink">{title}</h2>
        {description && <p className="mt-1 text-sm text-gray-600">{description}</p>}
      </div>
      {action && <div>{action}</div>}
    </div>
  );
}
