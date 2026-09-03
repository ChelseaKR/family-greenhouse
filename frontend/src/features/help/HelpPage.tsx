import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { PublicShell, PageIntro } from '@/components/PublicShell';
import { useMetaTags } from '@/hooks/useMetaTags';
import { siteUrl } from '@/config/site';
import { isNativeApp } from '@/lib/platform';
import { useAuthStore } from '@/store/authStore';
import { BackToApp } from './BackToApp';
import { SUPPORT_EMAIL, POPULAR, visibleSections } from './helpContent';

/**
 * Public help index at `/help`.
 *
 * Public on purpose. Help used to live behind `ProtectedRoute`, which meant
 * the answers to "how do I cancel", "what does a sitter see", and "why didn't
 * my reminder arrive" were unreachable to the two audiences most likely to
 * ask them: someone deciding whether to sign up, and someone locked out of
 * their account. It also meant no search engine could index a single one of
 * them.
 *
 * This page is the browse-and-filter surface: every question on one page,
 * collapsed. The per-topic pages under `/help/:topicId` are the reading
 * surface, and they are where the FAQ structured data lives so one question
 * has one canonical home.
 *
 * Disclosure uses native <details>/<summary> rather than a button plus a
 * conditional render. Three reasons, all of them load-bearing here: the
 * keyboard and screen-reader semantics are correct without any JS, the answer
 * text stays in the DOM when collapsed (so browser find-in-page and crawlers
 * can both see it), and more than one answer can be open at a time — the old
 * accordion allowed exactly one, which is hostile when you are comparing two
 * plans or following a two-part answer.
 */
export function HelpPage() {
  const native = isNativeApp();
  // A signed-in reader gets a plain header and a way back into the app; the
  // public header's "Try the app" CTA is aimed at someone who has not signed
  // up, and reads as a dead end to someone who already has.
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const [query, setQuery] = useState('');
  const searchId = useId();

  useMetaTags({
    title: 'Help & FAQ — Family Greenhouse',
    description:
      'Answers about plants, tasks, reminders, households, plant sitters, plans and billing, and your data in Family Greenhouse.',
    canonical: siteUrl('/help'),
    robots: 'index, follow',
  });

  const sections = useMemo(() => visibleSections(native), [native]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sections;
    return sections
      .map((section) => ({
        ...section,
        articles: section.articles.filter(
          (a) => a.q.toLowerCase().includes(q) || a.text.toLowerCase().includes(q)
        ),
      }))
      .filter((section) => section.articles.length > 0);
  }, [query, sections]);

  const matchCount = filtered.reduce((n, section) => n + section.articles.length, 0);
  const searching = query.trim().length > 0;

  return (
    <PublicShell plainHeader={isAuthenticated}>
      <BackToApp show={isAuthenticated} />
      <PageIntro
        eyebrow="Help & FAQ"
        title="How can we help?"
        lede={
          <>
            Answers to the questions we actually get asked, grouped by topic. Everything here
            describes the product as it ships today — where something is unfinished or only works on
            some devices, it says so.
          </>
        }
      />

      <div role="search" className="mt-10">
        <label htmlFor={searchId} className="block text-sm font-medium text-ink">
          Search the help pages
        </label>
        <input
          id={searchId}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="cancel, reminder, sitter, export…"
          className="mt-2 w-full rounded-lg border border-dew bg-paper px-4 py-3 text-base text-ink placeholder:text-gray-500 focus:border-primary-500 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-primary-500"
        />
        {/* Announce the filtered count, not just the visual change: a
            keyboard/screen-reader user typing here otherwise gets no feedback
            that the page under them has shrunk to nothing. */}
        <p aria-live="polite" className="mt-2 text-sm text-gray-600">
          {searching
            ? `${matchCount} ${matchCount === 1 ? 'answer' : 'answers'} match “${query.trim()}”.`
            : ''}
        </p>
      </div>

      {!searching && (
        <nav aria-labelledby="help-popular" className="mt-10">
          <h2 id="help-popular" className="font-serif text-2xl tracking-tight text-ink">
            Start here
          </h2>
          <ul className="mt-4 grid gap-2 sm:grid-cols-2">
            {POPULAR.map((item) => (
              <li key={`${item.section}-${item.article}`}>
                <Link
                  to={`/help/${item.section}#${item.article}`}
                  className="block rounded-lg border border-dew bg-paper px-4 py-3 text-sm font-medium text-ink hover:border-primary-300 hover:bg-glass/40"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}

      {matchCount === 0 ? (
        <div className="mt-10 rounded-xl border border-dew bg-paper p-6">
          <p className="text-base text-gray-700">
            Nothing here matches “{query.trim()}”. Try a shorter phrase, browse the topics from the{' '}
            <button
              type="button"
              onClick={() => setQuery('')}
              className="text-primary-700 underline hover:text-primary-800"
            >
              full list
            </button>
            , or email{' '}
            <a
              className="text-primary-700 underline hover:text-primary-800"
              href={`mailto:${SUPPORT_EMAIL}`}
            >
              {SUPPORT_EMAIL}
            </a>
            .
          </p>
        </div>
      ) : (
        <div className="mt-12 space-y-12">
          {filtered.map((section) => (
            <section key={section.id} aria-labelledby={`section-${section.id}`}>
              <h2
                id={`section-${section.id}`}
                className="font-serif text-2xl tracking-tight text-ink border-b border-primary-100/80 pb-2"
              >
                <Link to={`/help/${section.id}`} className="hover:text-primary-800">
                  {section.title}
                </Link>
              </h2>
              <p className="mt-2 text-sm text-gray-600">{section.description}</p>
              <ul className="mt-4 divide-y divide-primary-100/60 rounded-xl border border-primary-100/80 bg-paper">
                {section.articles.map((article) => (
                  <li key={article.id}>
                    <details className="group" id={article.id}>
                      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 hover:bg-glass/40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500 [&::-webkit-details-marker]:hidden">
                        <h3 className="text-sm font-medium text-ink">{article.q}</h3>
                        <svg
                          className="h-5 w-5 shrink-0 text-gray-500 transition-transform group-open:rotate-180"
                          viewBox="0 0 20 20"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.7"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M5 8l5 5 5-5" />
                        </svg>
                      </summary>
                      <div className="prose-fg px-5 pb-5 text-sm">{article.a}</div>
                    </details>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-sm">
                <Link
                  to={`/help/${section.id}`}
                  className="text-primary-700 underline hover:text-primary-800"
                >
                  Read {section.title.toLowerCase()} as a full page
                </Link>
              </p>
            </section>
          ))}
        </div>
      )}

      <div className="mt-16 rounded-xl border border-primary-100/80 bg-glass/40 p-6">
        <h2 className="font-serif text-xl tracking-tight text-ink">Still stuck?</h2>
        <p className="mt-2 text-base text-gray-700">
          Email{' '}
          <a
            className="text-primary-700 underline hover:text-primary-800"
            href={`mailto:${SUPPORT_EMAIL}`}
          >
            {SUPPORT_EMAIL}
          </a>
          . Tell us what you were doing, what you expected, and what happened instead — and never
          send a password or a sign-in code. If logging in or syncing looks broken for everyone,{' '}
          <Link to="/status" className="text-primary-700 underline hover:text-primary-800">
            check the status page
          </Link>{' '}
          first.
        </p>
      </div>

      <p className="mt-8 text-sm text-gray-600">
        {sections.length} topics ·{' '}
        <Link to="/changelog" className="text-primary-700 underline hover:text-primary-800">
          what changed recently
        </Link>
      </p>
    </PublicShell>
  );
}
