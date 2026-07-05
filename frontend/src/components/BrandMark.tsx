import clsx from 'clsx';

interface BrandMarkProps {
  /** Lockup variant.
   *  - `mark`: just the greenhouse icon, no text.
   *  - `wordmark`: icon-on-chip + stacked "Family Greenhouse / Grow together"
   *    text. Used in nav bars and headers; matches the footer treatment so
   *    branding is consistent everywhere.
   *  - `wordmark-stacked`: full stacked lockup from the brand kit
   *    (`logo-stacked.svg`), for splash / onboarding hero. */
  variant?: 'mark' | 'wordmark' | 'wordmark-stacked';
  /** Tone of the wordmark text. Defaults to dark for light backgrounds;
   *  pass `'light'` for dark sidebars/footers so the text reads white. */
  tone?: 'dark' | 'light';
  /** Tailwind sizing for the wordmark variant — controls the icon chip
   *  height and the wordmark's text scale together. Default `md`. */
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  name?: string;
}

const SIZE_CLASSES: Record<
  NonNullable<BrandMarkProps['size']>,
  {
    icon: string;
    title: string;
    tagline: string;
  }
> = {
  sm: { icon: 'h-7', title: 'text-base', tagline: 'text-[11px]' },
  md: { icon: 'h-8', title: 'text-lg', tagline: 'text-xs' },
  lg: { icon: 'h-10', title: 'text-xl', tagline: 'text-xs' },
};

/**
 * Family Greenhouse brand mark. The `wordmark` variant is the canonical
 * lockup used in nav bars, headers, sidebars, and footers — so the
 * branding stays identical across every viewport. The icon ships on a
 * light-green plate (`primary-50`) so it stays legible on both light
 * and dark backgrounds without recoloring; only the wordmark text and
 * tagline switch tone.
 *
 * Brand assets live in `/public/brand/`. The lockup is composed in JSX
 * rather than baked into a single SVG so the type can pick up the
 * Fraunces display font and the tagline can use the small-caps
 * letter-spacing without us shipping a webfont inside the SVG.
 */
export function BrandMark({
  variant = 'wordmark',
  tone = 'dark',
  size = 'md',
  className,
  name = 'Family Greenhouse',
}: BrandMarkProps) {
  if (variant === 'mark') {
    return (
      <img
        src="/brand/icon.svg"
        alt={name}
        className={clsx('inline-block h-10 w-auto', className)}
      />
    );
  }

  if (variant === 'wordmark-stacked') {
    return (
      <img
        src="/brand/logo-stacked.svg"
        alt={name}
        className={clsx('inline-block h-32 w-auto', className)}
      />
    );
  }

  const s = SIZE_CLASSES[size];
  // Dark tone renders the name in brand ink, not stock near-black — the
  // lockup appears in every public header, so this is where the brand
  // color is either everywhere or nowhere.
  const titleColor = tone === 'light' ? 'text-white' : 'text-ink';
  const taglineColor = tone === 'light' ? 'text-primary-200' : 'text-primary-700';

  return (
    <span className={clsx('inline-flex items-center gap-3', className)} aria-label={name}>
      <span className="block rounded-md bg-primary-50 p-1">
        <img src="/brand/icon.svg" alt="" className={clsx(s.icon, 'w-auto')} />
      </span>
      <span className="flex flex-col leading-tight">
        <span className={clsx('font-serif font-semibold tracking-tight', s.title, titleColor)}>
          Family Greenhouse
        </span>
        <span className={clsx('uppercase tracking-[0.2em]', s.tagline, taglineColor)}>
          Grow together
        </span>
      </span>
    </span>
  );
}
