import { Link, Navigate, useParams } from 'react-router-dom';
import { ChevronLeftIcon } from '@heroicons/react/24/outline';
import { PublicShell } from '@/components/PublicShell';
import { CommercialHoldNotice } from '@/components/CommercialHoldNotice';
import { findPost, POSTS } from './posts';
import { useMetaTags } from '@/hooks/useMetaTags';
import { SITE_URL } from '@/config/site';

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
          title: `${post.title} — Family Greenhouse`,
          description: post.description,
          canonical: `${SITE_URL}/blog/${post.slug}`,
          ogType: 'article',
          // Article schema makes the post eligible for Google's article
          // rich-results treatment. We don't have author photos or a
          // publisher logo URL set up yet — those are nice-to-haves that
          // strengthen eligibility but aren't required.
          jsonLd: {
            '@context': 'https://schema.org',
            '@graph': [
              {
                '@type': 'Article',
                headline: post.title,
                description: post.description,
                datePublished: post.date,
                dateModified: post.date,
                author: { '@type': 'Organization', name: 'Family Greenhouse' },
                publisher: {
                  '@type': 'Organization',
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
  const otherPosts = POSTS.filter((p) => p.slug !== post.slug).slice(0, 2);

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

      <CommercialHoldNotice compact className="mt-16" />

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
