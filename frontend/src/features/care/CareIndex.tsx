import { Link } from 'react-router-dom';
import { PublicShell, PageIntro } from '@/components/PublicShell';
import { useMetaTags } from '@/hooks/useMetaTags';
import { siteUrl } from '@/config/site';
import { CARE_GUIDES } from './careGuides';
import { CommercialHoldNotice } from '@/components/CommercialHoldNotice';

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

      <CommercialHoldNotice compact className="mt-16" />
    </PublicShell>
  );
}
