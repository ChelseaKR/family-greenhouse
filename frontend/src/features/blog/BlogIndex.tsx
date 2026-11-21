import { Link } from 'react-router';
import { PublicShell, PageIntro } from '@/components/PublicShell';
import { POSTS } from './posts';
import { useMetaTags } from '@/hooks/useMetaTags';
import { SITE_URL, siteUrl } from '@/config/site';
import { formatContentDate } from '@/utils/contentDate';

const PAGE_TITLE = 'Blog — Family Greenhouse';
const PAGE_DESCRIPTION =
  'Notes on plant care, shared chores, and not letting your fiddle leaf die. From the team building Family Greenhouse.';

/** Newest first: the order the visible list renders. */
const POSTS_NEWEST_FIRST = [...POSTS].sort((a, b) => (a.date < b.date ? 1 : -1));

/**
 * CollectionPage / ItemList / BreadcrumbList, the shape /pet-safe and /care
 * publish. Before this the index was the only blog URL with no structured
 * data, while every post's breadcrumb already names it "Blog". The list is
 * POSTS_NEWEST_FIRST, the same array the page renders, so its order and URLs
 * match the visible links. Nothing here is visible.
 */
const BLOG_INDEX_JSON_LD = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'CollectionPage',
      '@id': siteUrl('/blog'),
      url: siteUrl('/blog'),
      name: PAGE_TITLE,
      description: PAGE_DESCRIPTION,
      inLanguage: 'en',
      isPartOf: {
        '@type': 'WebSite',
        '@id': `${SITE_URL}/#website`,
        name: 'Family Greenhouse',
        url: SITE_URL,
      },
      mainEntity: { '@id': siteUrl('/blog#posts') },
    },
    {
      '@type': 'ItemList',
      '@id': siteUrl('/blog#posts'),
      name: 'Family Greenhouse blog posts',
      numberOfItems: POSTS_NEWEST_FIRST.length,
      itemListElement: POSTS_NEWEST_FIRST.map((post, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name: post.title,
        url: siteUrl(`/blog/${post.slug}`),
      })),
    },
    {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: siteUrl('/') },
        { '@type': 'ListItem', position: 2, name: 'Blog' },
      ],
    },
  ],
};

/**
 * Blog index. Public, no auth required. Shares the marketing-page layout
 * shell (header lockup + footer) so readers landing here from search can
 * see the app immediately.
 */
export function BlogIndex() {
  useMetaTags({
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
    canonical: siteUrl('/blog'),
    jsonLd: BLOG_INDEX_JSON_LD,
  });

  return (
    <PublicShell contentLang="en">
      <PageIntro
        eyebrow="The journal"
        title="Notes on growing things"
        lede="Plant care, shared chores, and the occasional unsolicited opinion."
      />

      <ul className="mt-12 divide-y divide-primary-100/70">
        {POSTS_NEWEST_FIRST.map((post) => (
          <li key={post.slug} className="py-8 first:pt-0 last:pb-0">
            <Link to={`/blog/${post.slug}`} className="group block">
              <p className="text-xs font-medium uppercase tracking-[0.2em] text-primary-700">
                {formatContentDate(post.date)} · {post.readingMinutes} min read
              </p>
              <h2 className="mt-2 font-serif text-2xl tracking-tight text-ink group-hover:text-primary-700 transition-colors">
                {post.title}
              </h2>
              <p className="mt-2 text-base text-gray-700 leading-relaxed">{post.description}</p>
              <p className="mt-3 text-sm font-medium text-primary-700">Read more →</p>
            </Link>
          </li>
        ))}
      </ul>
    </PublicShell>
  );
}
