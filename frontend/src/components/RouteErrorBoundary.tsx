import { Component, type ReactNode } from 'react';

/**
 * Catches errors thrown while loading or rendering a lazy route. Suspense
 * alone only handles the loading state; if a chunk fetch fails (network
 * error, cache-busted CDN URL after a deploy, parse error) the user sees
 * an infinite spinner with no recovery.
 *
 * This boundary surfaces a small inline panel with a reload button. We
 * deliberately don't try to fix the failure (rehydrate the chunk, retry,
 * etc.) because the most common cause is a stale tab pointing at a
 * vendor chunk that no longer exists — a hard reload pulls the new
 * index.html with the current chunk hashes.
 */
interface State {
  error: Error | null;
}

interface Props {
  children: ReactNode;
}

export class RouteErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error('[route-boundary]', error);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div
        role="alert"
        className="mx-auto my-12 max-w-md rounded-md border border-amber-300 bg-amber-50 p-6"
      >
        <h2 className="mb-2 text-lg font-semibold text-amber-900">
          We couldn&apos;t load this page
        </h2>
        <p className="mb-4 text-sm text-amber-900">
          The page&apos;s code couldn&apos;t be fetched. This usually means the app updated while
          your tab was open. Refreshing should fix it.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-md bg-amber-900 px-4 py-2 text-sm font-medium text-white hover:bg-amber-800 min-h-touch min-w-touch"
        >
          Refresh
        </button>
      </div>
    );
  }
}
