import clsx from 'clsx';

/**
 * Base shimmer block. Content-shaped skeletons (below) compose these so a
 * loading list/grid reserves the same space the real content will occupy —
 * avoiding the layout shift a centered spinner causes when data lands.
 * `motion-safe:` keeps the pulse off for users who prefer reduced motion.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={clsx('motion-safe:animate-pulse rounded bg-primary-100/70', className)}
      aria-hidden="true"
    />
  );
}

function PlantCardSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border border-primary-100/70 bg-paper shadow-journal">
      <Skeleton className="aspect-square w-full rounded-none" />
      <div className="space-y-2 p-3">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    </div>
  );
}

/** Grid of plant-card placeholders mirroring the real PlantsPage grid. */
export function PlantGridSkeleton({ count = 10 }: { count?: number }) {
  return (
    <div
      className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
      role="status"
      aria-label="Loading plants"
    >
      {Array.from({ length: count }).map((_, i) => (
        <PlantCardSkeleton key={i} />
      ))}
      <span className="sr-only">Loading plants…</span>
    </div>
  );
}

function ListRowSkeleton() {
  return (
    <div className="flex items-center gap-4 py-3">
      <Skeleton className="h-9 w-9 rounded-full" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-3 w-1/4" />
      </div>
    </div>
  );
}

/** Stack of row placeholders for task/activity lists. */
export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <ListRowSkeleton key={i} />
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  );
}
