import { ReactNode } from 'react';
import clsx from 'clsx';
import { Footer } from './Footer';
import { SiteHeader } from './SiteHeader';
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
  /** Drop the nav links + sign-up button. The sitter page uses this: a guest
   *  doing someone a favor shouldn't be marketed at from the header. */
  plainHeader?: boolean;
  /** The language the page's own content is written in, when that is fixed
   *  whatever language the visitor chose. The help pages, the blog and the
   *  changelog are English by design (docs/i18n.md), and sat inside
   *  `<html lang="es">` for a Spanish-speaking visitor: a screen reader read
   *  English words with Spanish pronunciation rules (WCAG 3.1.2). The header
   *  and footer are translated and stay in the page language. */
  contentLang?: 'en';
  children: ReactNode;
}

export function PublicShell({
  width = 'prose',
  plainHeader = false,
  contentLang,
  children,
}: PublicShellProps) {
  return (
    <div className="min-h-screen bg-paper flex flex-col">
      {/* The one site header (SiteHeader.tsx), the same as the home page's. */}
      <SiteHeader plain={plainHeader} />

      <main
        lang={contentLang}
        className={clsx('flex-1 mx-auto w-full px-6 py-12 sm:py-16', WIDTHS[width])}
      >
        {children}
      </main>

      {/* `contents`: no box of its own, so the website lays out exactly as
          before; inside the iOS app's native frame the site footer goes. */}
      <div className="contents native-frame:hidden!">
        <Footer />
      </div>
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
 * Title treatment for public content pages: eyebrow, Bitter serif title
 * in ink, hand-drawn underline. Mirrors the landing page's SectionHeading
 * and the app's PageHeader so every surface opens the same way.
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
