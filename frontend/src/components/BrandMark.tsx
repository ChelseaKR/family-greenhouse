import clsx from 'clsx';

interface BrandMarkProps {
  /** Lockup variant.
   *  - `mark`: just the greenhouse icon, no text.
   *  - `wordmark`: icon-on-chip + stacked "Family Greenhouse / Grow together"
   *    text. Used in nav bars and headers; matches the footer treatment so
   *    branding is consistent everywhere.
   *  - `wordmark-stacked`: full stacked `logo.svg` lockup from the brand kit,
   *    for splash / onboarding hero. */
  variant?: 'mark' | 'wordmark' | 'wordmark-stacked';
  /** Tone of the wordmark text. Defaults to dark for light backgrounds;
   *  pass `'light'` for dark sidebars/footers so the text reads white. */
  tone?: 'dark' | 'light';
  /** Tailwind sizing for the wordmark variant — controls the icon chip
   *  height and the wordmark's text scale together. Default `md`. */
  size?: 'sm' | 'md' | 'lg';
  /** Collapse to the greenhouse glyph below 360px so public headers keep
   *  their navigation actions on one line. */
  compactOnMobile?: boolean;
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
  sm: { icon: 'h-8', title: 'text-base', tagline: 'text-[10px]' },
  md: { icon: 'h-9', title: 'text-lg', tagline: 'text-[11px]' },
  lg: { icon: 'h-11', title: 'text-xl', tagline: 'text-xs' },
};

/**
 * Family Greenhouse brand mark. The `wordmark` variant is the canonical
 * lockup used in nav bars, headers, sidebars, and footers — so the
 * branding stays identical across every viewport. The greenhouse glyph
 * depicts the product name directly: two plants sharing one glasshouse.
 *
 * Brand assets live in `/public/brand/`. The lockup is composed in JSX
 * rather than baked into a single SVG so the type can pick up the
 * Gloock display font and the tagline can use the small-caps
 * letter-spacing without us shipping a webfont inside the SVG.
 */
export function BrandMark({
  variant = 'wordmark',
  tone = 'dark',
  size = 'md',
  compactOnMobile = false,
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
        src="/brand/logo.svg"
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
      <span className="block overflow-hidden rounded-[0.7rem] bg-paper ring-1 ring-primary-200/70">
        <img src="/brand/icon.svg" alt="" className={clsx(s.icon, 'w-auto')} />
      </span>
      <span
        className={clsx('flex flex-col leading-tight', compactOnMobile && 'max-[360px]:hidden')}
      >
        <span className={clsx('font-serif tracking-tight', s.title, titleColor)}>
          Family Greenhouse
        </span>
        <span className={clsx('uppercase tracking-[0.2em]', s.tagline, taglineColor)}>
          Grow together
        </span>
      </span>
    </span>
  );
}
