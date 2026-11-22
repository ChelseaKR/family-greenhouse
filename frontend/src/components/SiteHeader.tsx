import { Link, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { BrandMark } from './BrandMark';
import { buttonStyles } from './buttonStyles';
import { PUBLIC_REGISTRATION_AVAILABLE } from '@/config/commercialStatus';
import { isNativeApp } from '@/lib/platform';
import { IS_BETA, BETA_BADGE } from '@/lib/betaMode';
import { contentCtaContext, trackGoogleConversion } from '@/services/googleAnalytics';
import { registerHrefForPlant } from '@/features/onboarding/guidePlantHandoff';

/**
 * The one site header, on the home page and every public content page
 * (IA decision D1, 2026-11-21). Until then the home page had its own header
 * (Features and Plans as in-page anchors, Log in, "Sign up free") and the
 * content pages another (Care guides, Blog, Plans, "Try the app →", no Log in),
 * and neither linked the pet-safety hub.
 *
 * Wide screens: Care guides · Pets and plants · Blog · Plans, then Log in and
 * "Sign up free". Below `lg`: the wordmark, "Sign up free" and a Menu whose
 * first item is Log in. Every label is an existing catalog key.
 *
 * Height: py-4 around a 44px target from `sm` up, as the content pages'
 * header was. Below `sm` the name wraps to two lines beside the button and
 * the Menu, so the tagline is hidden and the padding is py-3; that keeps
 * the care guide's "Remind me to water…" link on the first screen at every
 * viewport in care-cta-above-fold.spec.ts (375x548 included).
 */
const NAV_LINK =
  'text-sm font-medium text-ink hover:text-primary-700 transition-colors whitespace-nowrap';

interface SiteHeaderProps {
  /** Wordmark only. The sitter, caretaker and tag pages use this: a guest
   *  doing someone a favor shouldn't be marketed at from the header. */
  plain?: boolean;
  /** The legacy beta badge beside the wordmark; the home page only, as before. */
  showBetaBadge?: boolean;
}

export function SiteHeader({ plain = false, showBetaBadge = false }: SiteHeaderProps) {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  // The apps have no plans page (it opens Settings → Plan status), so the
  // header does not offer one: see WEB_ONLY_LINKS in Footer.tsx.
  const showPricing = !isNativeApp();
  const onHome = pathname === '/';
  // On a care guide or pet-safe page, "Sign up free" carries the page's plant
  // the same way the page's own sign-up links do, so the first run can offer
  // it first. Any other page is plain /register.
  const ctaContext = contentCtaContext(pathname);
  const registerHref =
    ctaContext.plant && (ctaContext.source === 'care_guide' || ctaContext.source === 'pet_safe')
      ? registerHrefForPlant(ctaContext.plant)
      : '/register';

  const links: Array<[label: string, to: string]> = [
    [t('publicShell.careGuides'), '/care'],
    [t('plantSafetyPage.breadcrumbHub'), '/pet-safe'],
    [t('publicShell.blog'), '/blog'],
    ...(showPricing ? ([[t('publicShell.pricing'), '/pricing']] as Array<[string, string]>) : []),
  ];

  const onSignUpClick = () => {
    // The home page keeps its own `cta` value; content pages send where the
    // click came from instead (docs/analytics.md). A click never sends both.
    if (onHome) {
      trackGoogleConversion({ name: 'landing_cta_click', cta: 'nav_signup' });
      return;
    }
    trackGoogleConversion({ name: 'landing_cta_click', ...ctaContext, placement: 'header' });
  };

  return (
    // print:hidden — the sticky site header is chrome, not content; a printed
    // page (the sitter handoff brief) should start at the title. The
    // safe-area padding carries its background under the status bar in the
    // native shells; env() is 0 in a browser tab.
    <header className="sticky top-0 z-40 border-b border-dew/60 bg-paper/95 pt-[env(safe-area-inset-top)] backdrop-blur-xs print:hidden native-frame:hidden!">
      <nav
        className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3 sm:px-6 sm:py-4 lg:px-8"
        aria-label={t('publicShell.siteNavLabel')}
      >
        <div className="flex min-w-0 items-center gap-2">
          <Link to="/" aria-label={t('publicShell.homeLabel', { tagline: t('brand.tagline') })}>
            <BrandMark variant="wordmark" size="sm" compactOnMobile hideTaglineOnMobile />
          </Link>
          {showBetaBadge && IS_BETA && (
            <span className="rounded-full bg-accent-100 text-accent-800 text-xs font-semibold px-2 py-0.5 border border-accent-200/70 whitespace-nowrap">
              {BETA_BADGE}
            </span>
          )}
        </div>
        {!plain && (
          <div className="flex shrink-0 items-center gap-x-3 sm:gap-x-6">
            {links.map(([label, to]) => (
              <Link key={to} to={to} className={`hidden lg:block ${NAV_LINK}`}>
                {label}
              </Link>
            ))}
            {/* Log in sits in the row on wide screens and first in the Menu
                below `lg`. With sign-up closed it is the only action, so it
                stays in the row at every width. */}
            <Link
              to="/login"
              className={`${PUBLIC_REGISTRATION_AVAILABLE ? 'hidden lg:block' : ''} ${NAV_LINK} font-semibold`}
            >
              {t('landing.nav.logIn')}
            </Link>
            {PUBLIC_REGISTRATION_AVAILABLE && (
              <Link to={registerHref} className={buttonStyles()} onClick={onSignUpClick}>
                {t('auth.signUpFree')}
              </Link>
            )}
            <details className="group relative lg:hidden">
              <summary className="flex min-h-touch min-w-touch cursor-pointer list-none items-center justify-center rounded-lg border border-dew bg-paper text-ink transition-colors hover:bg-glass/50 [&::-webkit-details-marker]:hidden">
                <span className="sr-only">{t('publicShell.openMenu')}</span>
                <svg
                  className="h-5 w-5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="M5 7h14M5 12h14M5 17h14" />
                </svg>
              </summary>
              <div className="absolute right-0 top-[calc(100%+0.6rem)] z-50 w-56 overflow-hidden rounded-xl border border-dew bg-paper p-2 shadow-journal">
                {[
                  ...(PUBLIC_REGISTRATION_AVAILABLE
                    ? ([[t('landing.nav.logIn'), '/login']] as Array<[string, string]>)
                    : []),
                  ...links,
                ].map(([label, to]) => (
                  <Link
                    key={to}
                    to={to}
                    className="flex min-h-touch items-center rounded-lg px-3 py-2 text-sm font-medium text-ink hover:bg-glass/55"
                  >
                    {label}
                  </Link>
                ))}
              </div>
            </details>
          </div>
        )}
      </nav>
    </header>
  );
}
