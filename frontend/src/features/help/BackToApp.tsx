import { Link } from 'react-router';

/**
 * Escape hatch for a signed-in reader. The help pages deliberately sit outside
 * the app shell so they can be public and indexable, which means the sidebar
 * is simply gone while you are reading them — without this, the way back is a
 * guess.
 */
export function BackToApp({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <nav aria-label="Back to app" className="mb-6">
      <Link to="/dashboard" className="text-sm text-primary-700 underline hover:text-primary-800">
        ← Back to your dashboard
      </Link>
    </nav>
  );
}
