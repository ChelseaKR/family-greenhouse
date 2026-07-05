import { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { BrandMark } from './BrandMark';
import { Footer } from './Footer';
import { TitleUnderline } from './brand/TitleUnderline';

/**
 * Shared chrome for the public content pages (care guides, blog, pricing,
 * changelog, legal, status, pet-safe, sitter). These ten pages used to
 * hand-roll the same white header/footer shell, which left them visually
 * severed from the garden-journal system the landing/auth/app surfaces
 * use — stark white where everything else is paper, gray rules where
 * everything else is green-tinted. One component, one look.
 *
 * Width maps to the reading measure each page already used: `article`
 * for single-column prose (blog post, care guide), `prose` for indexes,
 * `wide` for the pricing grid.
 */
const WIDTHS = {
  article: 'max-w-2xl',
  prose: 'max-w-3xl',
  wide: 'max-w-5xl',
} as const;

interface PublicShellProps {
  width?: keyof typeof WIDTHS;
  /** Drop the nav links + app CTA. The sitter page uses this: a guest
   *  doing someone a favor shouldn't be marketed at from the header. */
  plainHeader?: boolean;
  children: ReactNode;
}

export function PublicShell({ width = 'prose', plainHeader = false, children }: PublicShellProps) {
  return (
    <div className="min-h-screen bg-paper flex flex-col">
      <header className="border-b border-primary-100/80">
        <nav
          className={clsx('mx-auto flex items-center justify-between gap-4 p-6', WIDTHS[width])}
          aria-label="Site"
        >
          <Link to="/" aria-label="Family Greenhouse home">
            <BrandMark variant="wordmark" size="sm" />
          </Link>
          {!plainHeader && (
            <div className="flex items-center gap-x-6">
              <Link
                to="/care"
                className="hidden md:block text-sm font-medium text-ink hover:text-primary-700 transition-colors"
              >
                Care guides
              </Link>
              <Link
                to="/blog"
                className="hidden md:block text-sm font-medium text-ink hover:text-primary-700 transition-colors"
              >
                Blog
              </Link>
              <Link
                to="/pricing"
                className="hidden md:block text-sm font-medium text-ink hover:text-primary-700 transition-colors"
              >
                Pricing
              </Link>
              <Link
                to="/"
                className="text-sm font-semibold text-primary-700 hover:text-primary-800 whitespace-nowrap"
              >
                Try the app →
              </Link>
            </div>
          )}
        </nav>
      </header>

      <main className={clsx('flex-1 mx-auto w-full px-6 py-12 sm:py-16', WIDTHS[width])}>
        {children}
      </main>

      <Footer />
    </div>
  );
}

interface PageIntroProps {
  /** Small label above the title, e.g. "Health check". */
  eyebrow?: string;
  title: string;
  /** Secondary line below the underline. */
  lede?: ReactNode;
  align?: 'left' | 'center';
}

/**
 * Title treatment for public content pages: eyebrow, Gloock serif title
 * in ink, hand-drawn underline. Mirrors the landing page's SectionHeading
 * and the app's PageHeader so every surface opens the same way.
 *
 * No font-semibold on the title: Gloock ships a single 400 weight, and a
 * bold utility only buys synthetic emboldening that muddies the serifs.
 */
export function PageIntro({ eyebrow, title, lede, align = 'left' }: PageIntroProps) {
  const centered = align === 'center';
  return (
    <div className={clsx(centered && 'text-center max-w-2xl mx-auto')}>
      {eyebrow && (
        <p className="text-xs uppercase tracking-[0.22em] text-primary-700 font-semibold">
          {eyebrow}
        </p>
      )}
      <h1
        className={clsx(
          'font-serif text-4xl tracking-tight text-ink sm:text-5xl',
          eyebrow && 'mt-3'
        )}
      >
        {title}
      </h1>
      <div className={clsx('mt-2', centered && 'flex justify-center')}>
        <TitleUnderline className="h-3 w-40 text-primary-600" />
      </div>
      {lede && <p className="mt-5 text-lg leading-8 text-gray-700">{lede}</p>}
    </div>
  );
}
