import { Link } from 'react-router-dom';
import { EmptySearch } from './illustrations/EmptySearch';
import { useMetaTags } from '@/hooks/useMetaTags';

export function NotFoundPage() {
  useMetaTags({
    title: 'Page not found — Family Greenhouse',
    description: 'This page does not exist in Family Greenhouse.',
    robots: 'noindex, nofollow',
  });

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-4 bg-paper text-center">
      <EmptySearch className="h-36 w-auto" />
      <h1 className="mt-6 font-serif text-4xl text-ink">Nothing growing here</h1>
      <p className="mt-3 max-w-md text-gray-600">
        This address doesn&rsquo;t match anything in the greenhouse. The link might be old, or the
        page may have moved.
      </p>
      <Link to="/" className="mt-8 btn-primary">
        Go back home
      </Link>
    </main>
  );
}
