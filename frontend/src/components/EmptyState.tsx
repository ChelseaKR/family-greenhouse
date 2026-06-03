import { ReactNode } from 'react';

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center text-center py-12 px-6">
      {/* The icon renders without a fixed-size wrapper because the
          illustrations we hand it (EmptyTasks, EmptyPlants, etc.) size
          themselves via their own className. A `h-12 w-12` wrapper here
          let the SVG overflow while only reserving 48px of layout
          space — the bug that stacked the title and CTA right on top of
          the artwork. */}
      {icon && (
        <div className="mb-4 text-primary-600" aria-hidden="true">
          {icon}
        </div>
      )}
      <h3 className="font-serif text-xl text-ink">{title}</h3>
      {description && <p className="mt-1 text-sm text-gray-600 max-w-md">{description}</p>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
