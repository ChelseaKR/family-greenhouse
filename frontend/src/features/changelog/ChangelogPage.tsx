import { Link } from 'react-router-dom';
import { BrandMark } from '@/components/BrandMark';
import { Footer } from '@/components/Footer';
import { useMetaTags } from '@/hooks/useMetaTags';

/**
 * Public changelog. Lightweight transparency move — show what changed,
 * when, in plain language. Hand-curated like the blog (a CMS would be
 * over-engineering for an entry every few weeks).
 *
 * Entries are most-recent first. Group by month for easy scanning. Each
 * entry has a category tag so power users can skim for the kind of
 * change they care about ("Reliability" vs "Feature").
 */

type Category = 'Feature' | 'Improvement' | 'Reliability' | 'Design' | 'Fix';

interface Entry {
  date: string;
  category: Category;
  title: string;
  body: React.ReactNode;
}

const CATEGORY_STYLES: Record<Category, string> = {
  Feature: 'bg-primary-100 text-primary-900',
  Improvement: 'bg-blue-100 text-blue-900',
  Reliability: 'bg-amber-100 text-amber-900',
  Design: 'bg-purple-100 text-purple-900',
  Fix: 'bg-gray-100 text-gray-700',
};

const ENTRIES: Entry[] = [
  {
    date: '2026-06-12',
    category: 'Design',
    title: 'A landing page that sounds like a person',
    body: (
      <>
        Rewrote the marketing copy in plain language and redrew the landing page: a left-aligned
        hero, six hand-drawn botanical feature icons, varied card layouts, and the sprig dividers
        the rest of the site already used. Also fixed a batch of small-screen layout bugs (the
        sign-up button no longer wraps on phones, tablets get proper two-column grids) and bumped
        low-contrast helper text across the app.
      </>
    ),
  },
  {
    date: '2026-06-12',
    category: 'Feature',
    title: 'Spider plant care guide',
    body: (
      <>
        Fourth entry in the <Link to="/care">care guides</Link>: the spider plant — why brown tips
        are usually your tap water, and what to do with all those plantlets.
      </>
    ),
  },
  {
    date: '2026-06-12',
    category: 'Fix',
    title: 'Dark mode removed (for now)',
    body: (
      <>
        The old toggle only recolored the page background, which left cards and forms unreadable.
        It&rsquo;s gone until components get real dark variants.
      </>
    ),
  },
  {
    date: '2026-04-25',
    category: 'Design',
    title: 'New brand identity',
    body: (
      <>
        Refreshed visual identity — illustrated greenhouse mark, Gloock for headlines, Instrument
        Sans for body, and a new color palette built around the Leaf Mid green. Affects the whole
        app: header, sidebar, marketing, blog, and the favicon.
      </>
    ),
  },
  {
    date: '2026-04-25',
    category: 'Feature',
    title: 'Public /blog and /changelog pages',
    body: (
      <>
        New blog at <code>/blog</code> with longer-form posts about plant care + collaboration. This
        page (the changelog) is the other side of the same coin — what we&rsquo;re shipping, in
        plain language.
      </>
    ),
  },
  {
    date: '2026-04-24',
    category: 'Reliability',
    title: 'Notification dispatcher matrix test',
    body: (
      <>
        17 cases pinning channel × Do-Not-Disturb × timezone behavior so we can&rsquo;t accidentally
        send a 3am SMS via timezone math. DND windows that wrap past midnight, locale-aware quiet
        hours, half-open window edges all covered.
      </>
    ),
  },
  {
    date: '2026-04-24',
    category: 'Feature',
    title: 'Multi-household per user',
    body: (
      <>
        You can now belong to more than one household — vacation place, a parent&rsquo;s plants, a
        roommate group. The sidebar gets a switcher; your &ldquo;default&rdquo; (first) household
        stays attached to your login for clients without the switcher.
      </>
    ),
  },
  {
    date: '2026-04-23',
    category: 'Feature',
    title: 'Local climate awareness',
    body: (
      <>
        Set a household location and the dashboard surfaces local weather plus derived care tips:
        humidity warnings, freeze alerts, &ldquo;skip watering today&rdquo; on rainy days.
        OpenWeatherMap-backed; degrades cleanly when not configured.
      </>
    ),
  },
  {
    date: '2026-04-23',
    category: 'Feature',
    title: 'Care analytics dashboard',
    body: (
      <>
        New{' '}
        <Link to="/" className="text-primary-700 underline">
          Analytics
        </Link>{' '}
        page with KPI tiles, 30-day trend with a 7-day moving average, per-task-type breakdown,
        plants-at-risk ranked by days overdue, and per-member contributions for the year. Pure
        SVG/CSS, no charting library dependency.
      </>
    ),
  },
  {
    date: '2026-04-22',
    category: 'Feature',
    title: 'Perenual species data integration',
    body: (
      <>
        Smarter species autocomplete (10K+ plants), suggested watering schedules at plant creation,
        long-form care guides on each plant&rsquo;s detail page, image fallbacks, and opt-in
        seasonal pest alerts. Feature-gated by an environment variable so the app degrades cleanly
        when the integration is off.
      </>
    ),
  },
  {
    date: '2026-04-22',
    category: 'Improvement',
    title: 'Quality audit + fixes',
    body: (
      <>
        Tightened observability (X-Ray traces correlated to logs), CDN caching on public endpoints,
        per-user write-side rate limits, end-to-end coverage on the create-plant flow, language
        picker gated until non-English content is real, refactor of branchy account-deletion paths.
      </>
    ),
  },
  {
    date: '2026-04-21',
    category: 'Improvement',
    title: 'Bulk apply care templates',
    body: (
      <>
        From the Plants page, pick a template and check the plants you want to apply it to. Capped
        at 50 plants per call so the request stays small.
      </>
    ),
  },
  {
    date: '2026-04-20',
    category: 'Feature',
    title: 'Cmd-K global search',
    body: (
      <>
        Press{' '}
        <kbd className="rounded border border-gray-200 bg-gray-50 px-1 font-sans text-xs">⌘K</kbd>{' '}
        anywhere to search across plants and tasks. Results split by type; press Enter to jump.
      </>
    ),
  },
];

function groupByMonth(entries: Entry[]): Map<string, Entry[]> {
  const out = new Map<string, Entry[]>();
  for (const e of entries) {
    const month = new Date(e.date).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
    });
    const list = out.get(month) ?? [];
    list.push(e);
    out.set(month, list);
  }
  return out;
}

export function ChangelogPage() {
  useMetaTags({
    title: 'Changelog — Family Greenhouse',
    description: "What's new in Family Greenhouse, in plain language.",
  });

  const grouped = groupByMonth(ENTRIES);

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
          What&rsquo;s new
        </h1>
        <p className="mt-3 text-lg text-gray-600">
          Things we&rsquo;ve shipped, in plain language. Most recent first.
        </p>

        <div className="mt-12 space-y-12">
          {[...grouped.entries()].map(([month, entries]) => (
            <section key={month}>
              <h2 className="font-serif text-2xl font-semibold tracking-tight text-gray-900 border-b border-gray-200 pb-2">
                {month}
              </h2>
              <ul className="mt-6 space-y-8">
                {entries.map((e, i) => (
                  <li key={`${e.date}-${i}`}>
                    <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.15em]">
                      <span className={`rounded-full px-2 py-0.5 ${CATEGORY_STYLES[e.category]}`}>
                        {e.category}
                      </span>
                      <span className="text-gray-500 normal-case tracking-normal">
                        {new Date(e.date).toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric',
                        })}
                      </span>
                    </div>
                    <h3 className="mt-2 font-serif text-xl font-semibold tracking-tight text-gray-900">
                      {e.title}
                    </h3>
                    <p className="mt-2 text-base text-gray-700 leading-relaxed">{e.body}</p>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </main>

      <Footer />
    </div>
  );
}
