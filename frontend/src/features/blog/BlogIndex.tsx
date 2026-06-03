import { Link } from 'react-router-dom';
import { BrandMark } from '@/components/BrandMark';
import { Footer } from '@/components/Footer';
import { POSTS } from './posts';
import { useMetaTags } from '@/hooks/useMetaTags';

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
          Notes on growing things
        </h1>
        <p className="mt-3 text-lg text-gray-600">
          Plant care, shared chores, and the occasional unsolicited opinion.
        </p>

        <ul className="mt-12 space-y-10">
          {[...POSTS]
            .sort((a, b) => (a.date < b.date ? 1 : -1))
            .map((post) => (
              <li key={post.slug}>
                <Link to={`/blog/${post.slug}`} className="group block">
                  <p className="text-xs font-medium uppercase tracking-[0.2em] text-primary-700">
                    {new Date(post.date).toLocaleDateString(undefined, {
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                    })}{' '}
                    · {post.readingMinutes} min read
                  </p>
                  <h2 className="mt-2 font-serif text-2xl font-semibold tracking-tight text-gray-900 group-hover:text-primary-700 transition-colors">
                    {post.title}
                  </h2>
                  <p className="mt-2 text-base text-gray-600 leading-relaxed">{post.description}</p>
                  <p className="mt-3 text-sm font-medium text-primary-700">Read more →</p>
                </Link>
              </li>
            ))}
        </ul>
      </main>

      <Footer />
    </div>
  );
}
