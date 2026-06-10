import { Link } from 'react-router-dom';
import { BrandMark } from '@/components/BrandMark';
import { Footer } from '@/components/Footer';
import { useMetaTags } from '@/hooks/useMetaTags';
import { CARE_GUIDES } from './careGuides';

/**
 * Index of the species care guides. Doubles as the internal-linking hub that
 * passes authority to the individual `/care/:slug` pages and gives the crawler
 * a single page that links them all. Public, no auth.
 */
export function CareIndex() {
  useMetaTags({
    title: 'Plant Care Guides — How Often to Water Common Houseplants',
    description:
      'Straight, no-nonsense care guides for common houseplants: how often to water, how much light, and why yours might be dying.',
  });

  return (
    <div className="min-h-screen bg-white flex flex-col">
      <header className="border-b border-gray-200">
        <nav className="mx-auto max-w-3xl flex items-center justify-between p-6">
          <Link to="/" aria-label="Family Greenhouse home">
            <BrandMark variant="wordmark" size="sm" />
          </Link>
          <Link to="/" className="text-sm font-medium text-primary-700 hover:underline">
            Try the app →
          </Link>
        </nav>
      </header>

      <main className="flex-1 mx-auto max-w-3xl w-full px-6 py-16">
        <h1 className="font-serif text-4xl font-semibold tracking-tight text-gray-900 sm:text-5xl">
          Plant care guides
        </h1>
        <p className="mt-3 text-lg text-gray-600">
          How often to water it, how much light it wants, and why yours is doing that. Honest,
          specific, no “lush green companion” filler.
        </p>

        <ul className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2">
          {CARE_GUIDES.map((g) => (
            <li key={g.slug}>
              <Link
                to={`/care/${g.slug}`}
                className="group block h-full rounded-lg border border-primary-100 p-5 transition-colors hover:border-primary-300 hover:bg-primary-50/50"
              >
                <h2 className="font-serif text-xl font-semibold text-gray-900 group-hover:text-primary-700">
                  {g.commonName}
                </h2>
                <p className="mt-1 text-sm italic text-gray-500">{g.scientificName}</p>
                <p className="mt-3 text-sm text-gray-600">{g.quickFacts.water}</p>
              </Link>
            </li>
          ))}
        </ul>

        <aside className="mt-16 rounded-lg border border-primary-200 bg-primary-50 p-6 text-center">
          <p className="font-serif text-xl font-semibold text-gray-900">
            Knowing the schedule is the easy part
          </p>
          <p className="mt-2 text-sm text-gray-600">
            The hard part is remembering — and not assuming someone else did it. Family Greenhouse
            handles both. Free for up to 10 plants.
          </p>
          <div className="mt-4">
            <Link
              to="/register"
              className="inline-flex items-center rounded-md bg-primary-700 px-4 py-2 text-sm font-medium text-white hover:bg-primary-800 min-h-touch"
            >
              Get started
            </Link>
          </div>
        </aside>
      </main>

      <Footer />
    </div>
  );
}
