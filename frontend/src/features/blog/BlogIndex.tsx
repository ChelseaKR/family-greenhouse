import { Link } from 'react-router-dom';
import { PublicShell, PageIntro } from '@/components/PublicShell';
import { POSTS } from './posts';
import { useMetaTags } from '@/hooks/useMetaTags';
import { siteUrl } from '@/config/site';

const PAGE_TITLE = 'Blog — Family Greenhouse';
const PAGE_DESCRIPTION =
  'Notes on plant care, shared chores, and not letting your fiddle leaf die. From the team building Family Greenhouse.';

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
  });

  return (
    <PublicShell>
      <PageIntro
        eyebrow="The journal"
        title="Notes on growing things"
        lede="Plant care, shared chores, and the occasional unsolicited opinion."
      />

      <ul className="mt-12 divide-y divide-primary-100/70">
        {[...POSTS]
          .sort((a, b) => (a.date < b.date ? 1 : -1))
          .map((post) => (
            <li key={post.slug} className="py-8 first:pt-0 last:pb-0">
              <Link to={`/blog/${post.slug}`} className="group block">
                <p className="text-xs font-medium uppercase tracking-[0.2em] text-primary-700">
                  {new Date(post.date).toLocaleDateString(undefined, {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                  })}{' '}
                  · {post.readingMinutes} min read
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
