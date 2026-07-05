import { Link } from 'react-router-dom';
import { PublicShell, PageIntro } from '@/components/PublicShell';
import { useMetaTags } from '@/hooks/useMetaTags';
import { siteUrl } from '@/config/site';
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
    canonical: siteUrl('/care'),
  });

  return (
    <PublicShell>
      <PageIntro
        eyebrow="Before the plant comes home"
        title="Plant care guides"
        lede="How often to water it, how much light it wants, and why yours is doing that. Honest, specific, no “lush green companion” filler."
      />

      <ul className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {CARE_GUIDES.map((g) => (
          <li key={g.slug}>
            <Link
              to={`/care/${g.slug}`}
              className="group block h-full rounded-xl border border-primary-100/80 bg-white p-5 shadow-journal transition hover:border-primary-300 hover:shadow-journal-hover"
            >
              <h2 className="font-serif text-xl text-ink group-hover:text-primary-700">
                {g.commonName}
              </h2>
              <p className="mt-1 text-sm italic text-gray-600">{g.scientificName}</p>
              <p className="mt-3 text-sm text-gray-600">{g.quickFacts.water}</p>
            </Link>
          </li>
        ))}
      </ul>

      <aside className="mt-16 rounded-xl border border-primary-200 bg-primary-50 p-6 text-center">
        <p className="font-serif text-xl text-ink">Knowing the schedule is the easy part</p>
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
    </PublicShell>
  );
}
