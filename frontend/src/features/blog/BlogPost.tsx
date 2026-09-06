import { Link, Navigate, useParams } from 'react-router';
import { ChevronLeftIcon } from '@heroicons/react/24/outline';
import { PublicShell } from '@/components/PublicShell';
import { buttonStyles } from '@/components/buttonStyles';
import { findPost, POSTS } from './posts';
import { useMetaTags } from '@/hooks/useMetaTags';
import { SITE_URL } from '@/config/site';
import { DEFAULT_OG_IMAGE } from '@/config/seo';
import { PUBLIC_REGISTRATION_AVAILABLE } from '@/config/commercialStatus';

/**
 * Single-post page. The post itself is a self-contained TSX component;
 * this wrapper supplies the meta tags, the chrome (header/footer), the
 * typographic frame for prose content, and a tail CTA back to the app.
 */
export function BlogPost() {
  const { slug } = useParams<{ slug: string }>();
  const post = slug ? findPost(slug) : undefined;

  useMetaTags(
    post
      ? {
          // No ` — Family Greenhouse` suffix. The raw titles are 41-53
          // chars and the 20-char suffix pushed every one of the 14 past
          // the ~60 truncation point, spending the cut on the brand rather
          // than the headline. Google renders the site name separately
          // anyway, and the H1 and breadcrumb already establish it.
          title: post.title,
          description: post.metaDescription ?? post.description,
          canonical: `${SITE_URL}/blog/${post.slug}`,
          ogType: 'article',
          // Only publishedTime: the manifest has no `modified` field, so
          // there is no honest value for article:modified_time.
          article: { publishedTime: post.date, section: 'Blog' },
          // Article schema makes the post eligible for Google's article
          // rich-results treatment. Publisher logo and `image` are both set
          // below; a per-post hero image and a named Person author are the
          // remaining strengtheners.
          jsonLd: {
            '@context': 'https://schema.org',
            '@graph': [
              {
                '@type': 'Article',
                headline: post.title,
                // The SERP-length copy, matching what the meta description
                // says, rather than the longer index-card preview.
                description: post.metaDescription ?? post.description,
                // Google lists `image` as required for the Article rich
                // result, and every post was omitting it — so all 14 were
                // ineligible for the mobile SERP / Discover thumbnail despite
                // otherwise-correct schema. No post ships a hero image yet, so
                // this falls back to the shared 1200x630 social card, which is
                // a valid ImageObject and unblocks eligibility today. Swap for
                // a per-post image when one exists.
                image: {
                  '@type': 'ImageObject',
                  url: DEFAULT_OG_IMAGE,
                  width: 1200,
                  height: 630,
                },
                datePublished: post.date,
                dateModified: post.date,
                author: { '@type': 'Organization', name: 'Family Greenhouse' },
                publisher: {
                  '@type': 'Organization',
                  // Same @id the homepage graph defines for this entity, so
                  // the publisher on 14 posts, 24 guides and the homepage is
                  // one Organization rather than three unlinked duplicates.
                  // The name and logo stay: Google's Article spec wants them
                  // present, and a bare @id reference into another document
                  // is not guaranteed to resolve.
                  '@id': `${SITE_URL}/#organization`,
                  name: 'Family Greenhouse',
                  logo: {
                    '@type': 'ImageObject',
                    url: `${SITE_URL}/brand/icon-512.png`,
                  },
                },
                mainEntityOfPage: {
                  '@type': 'WebPage',
                  '@id': `${SITE_URL}/blog/${post.slug}`,
                },
              },
              {
                '@type': 'BreadcrumbList',
                itemListElement: [
                  { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL },
                  { '@type': 'ListItem', position: 2, name: 'Blog', item: `${SITE_URL}/blog` },
                  { '@type': 'ListItem', position: 3, name: post.title },
                ],
              },
            ],
          },
        }
      : {}
  );

  if (!post) {
    return <Navigate to="/blog" replace />;
  }

  const Body = post.Component;
  // Same rotation as CareGuidePage, same reason: `.slice(0, 2)` linked every
  // post to the first two in the manifest, so how-to-remember-to-water-plants
  // and sharing-plant-care-without-becoming-the-nag took 13 inbound links each
  // while five posts had none at all and were reachable only from /blog.
  const relatedCount = Math.min(2, POSTS.length - 1);
  const postIndex = POSTS.findIndex((p) => p.slug === post.slug);
  const otherPosts = Array.from(
    { length: relatedCount },
    (_, i) => POSTS[(postIndex + 1 + i) % POSTS.length]
  ).filter((p) => p !== undefined);

  return (
    <PublicShell width="article">
      <Link
        to="/blog"
        className="inline-flex items-center gap-1 text-sm font-medium text-primary-700 hover:underline"
      >
        <ChevronLeftIcon className="h-4 w-4" aria-hidden="true" />
        All posts
      </Link>

      <header className="mt-6 mb-10">
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-primary-700">
          {new Date(post.date).toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          })}{' '}
          · {post.readingMinutes} min read
        </p>
        <h1 className="mt-3 font-serif text-4xl tracking-tight text-ink sm:text-5xl">
          {post.title}
        </h1>
      </header>

      <Body />

      {PUBLIC_REGISTRATION_AVAILABLE && (
        <aside className="mt-16 rounded-xl border border-primary-200 bg-primary-50 p-6 text-center">
          <p className="font-serif text-xl text-ink">Try Family Greenhouse</p>
          <p className="mt-2 text-sm text-gray-600">
            Free for one home, up to 3 household members and 20 plants. No credit card.
          </p>
          <div className="mt-4">
            <Link to="/register" className={buttonStyles()}>
              Get started
            </Link>
          </div>
        </aside>
      )}

      {otherPosts.length > 0 && (
        <section className="mt-16">
          <h2 className="font-serif text-2xl tracking-tight text-ink">More to read</h2>
          <ul className="mt-6 space-y-6">
            {otherPosts.map((p) => (
              <li key={p.slug}>
                <Link to={`/blog/${p.slug}`} className="group block">
                  <h3 className="font-serif text-lg text-ink group-hover:text-primary-700 transition-colors">
                    {p.title}
                  </h3>
                  <p className="mt-1 text-sm text-gray-600">{p.description}</p>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </PublicShell>
  );
}
