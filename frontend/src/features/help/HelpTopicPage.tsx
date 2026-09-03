import { useMemo } from 'react';
import { Link, useParams } from 'react-router';
import { PublicShell, PageIntro } from '@/components/PublicShell';
import { useMetaTags } from '@/hooks/useMetaTags';
import { siteUrl } from '@/config/site';
import { isNativeApp } from '@/lib/platform';
import { useAuthStore } from '@/store/authStore';
import { BackToApp } from './BackToApp';
import { SUPPORT_EMAIL, findSection, visibleSections } from './helpContent';

/**
 * One help topic at `/help/:topicId` — the reading surface, and the canonical
 * home of each question.
 *
 * Answers are rendered expanded rather than behind disclosure widgets. The
 * index page is where you skim forty questions; by the time someone is on
 * "Plans & billing" they want to read the whole thing, and a page of six
 * closed accordions is six extra clicks for no benefit. Each question is a
 * real `<h2>` with a stable `id`, so a support reply can link straight to the
 * paragraph that answers the email.
 *
 * The FAQ structured data lives here and not on the index deliberately: the
 * index carries every question, so emitting it in both places would publish
 * two competing homes for the same question.
 */
export function HelpTopicPage() {
  const { topicId } = useParams<{ topicId: string }>();
  const native = isNativeApp();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const section = findSection(topicId, native);

  const jsonLd = useMemo(() => {
    if (!section) return undefined;
    return {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: section.articles.map((article) => ({
        '@type': 'Question',
        name: article.q,
        acceptedAnswer: { '@type': 'Answer', text: article.text },
      })),
    };
  }, [section]);

  useMetaTags(
    section
      ? {
          title: `${section.title} — Family Greenhouse help`,
          description: section.description,
          canonical: siteUrl(`/help/${section.id}`),
          robots: 'index, follow',
          jsonLd,
        }
      : {
          title: 'Help topic not found — Family Greenhouse',
          description: 'That help topic does not exist.',
          // A mistyped or retired topic id is a valid-looking SPA URL that
          // resolves to nothing. Keep it out of the index rather than letting
          // it compete with the real topic pages.
          robots: 'noindex, nofollow',
        }
  );

  if (!section) {
    const available = visibleSections(native);
    return (
      <PublicShell plainHeader={isAuthenticated}>
        <BackToApp show={isAuthenticated} />
        <PageIntro
          eyebrow="Help & FAQ"
          title="We don’t have that topic"
          lede="The link may be out of date. Here is everything we do cover."
        />
        <ul className="mt-8 space-y-2">
          {available.map((s) => (
            <li key={s.id}>
              <Link
                to={`/help/${s.id}`}
                className="text-primary-700 underline hover:text-primary-800"
              >
                {s.title}
              </Link>
              <span className="text-gray-600"> — {s.description}</span>
            </li>
          ))}
        </ul>
        <p className="mt-8 text-base text-gray-700">
          Or start from the{' '}
          <Link to="/help" className="text-primary-700 underline hover:text-primary-800">
            help index
          </Link>
          .
        </p>
      </PublicShell>
    );
  }

  return (
    <PublicShell plainHeader={isAuthenticated}>
      <BackToApp show={isAuthenticated} />
      <nav aria-label="Breadcrumb" className="mb-6">
        <Link to="/help" className="text-sm text-primary-700 underline hover:text-primary-800">
          ← All help topics
        </Link>
      </nav>

      <PageIntro eyebrow="Help & FAQ" title={section.title} lede={section.description} />

      {section.articles.length > 1 && (
        <nav
          aria-labelledby="on-this-page"
          className="mt-10 rounded-xl border border-dew bg-glass/30 p-5"
        >
          <h2
            id="on-this-page"
            className="text-sm font-semibold uppercase tracking-wider text-primary-800"
          >
            On this page
          </h2>
          <ul className="mt-3 space-y-1.5">
            {section.articles.map((article) => (
              <li key={article.id}>
                <a
                  href={`#${article.id}`}
                  className="text-sm text-primary-700 underline hover:text-primary-800"
                >
                  {article.q}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      )}

      <div className="mt-12 space-y-12">
        {section.articles.map((article) => (
          <article key={article.id} aria-labelledby={article.id}>
            {/* scroll-mt keeps the sticky PublicShell header from covering the
                heading when an anchor link lands on it. */}
            <h2
              id={article.id}
              className="scroll-mt-24 font-serif text-2xl tracking-tight text-ink"
            >
              {article.q}
            </h2>
            <div className="prose-fg mt-3">{article.a}</div>
          </article>
        ))}
      </div>

      <div className="mt-16 rounded-xl border border-primary-100/80 bg-glass/40 p-6">
        <h2 className="font-serif text-xl tracking-tight text-ink">Didn’t answer it?</h2>
        <p className="mt-2 text-base text-gray-700">
          Email{' '}
          <a
            className="text-primary-700 underline hover:text-primary-800"
            href={`mailto:${SUPPORT_EMAIL}`}
          >
            {SUPPORT_EMAIL}
          </a>{' '}
          — a real person reads it. Never include a password or a sign-in code.
        </p>
      </div>

      <p className="mt-8 text-sm">
        <Link to="/help" className="text-primary-700 underline hover:text-primary-800">
          Back to all help topics
        </Link>
      </p>
    </PublicShell>
  );
}
