import { Link, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { BrandMark } from './BrandMark';
import { MemorialFrame } from './brand/MemorialFrame';
import { AnalyticsOptOutToggle } from './AnalyticsOptOutToggle';
import { isNativeApp } from '@/lib/platform';
import { useGiftAvailability } from '@/features/gift/useGiftAvailability';

interface FooterLink {
  labelKey: string;
  /** A route, rendered as a router link. */
  to?: string;
  /** A plain href: an in-page anchor on the home page, or the contact mailbox. */
  href?: string;
}

// Labels are catalog keys (#467). Every one is shared with the site header or
// was already in one of the two old footers, so no word is translated twice.
const FOOTER_GROUPS: Array<{ headingKey: string; links: FooterLink[] }> = [
  {
    headingKey: 'landing.footer.learn',
    links: [
      { labelKey: 'landing.footer.plantCareGuides', to: '/care' },
      { labelKey: 'landing.footer.petSafeChecker', to: '/pet-safe' },
      { labelKey: 'publicShell.blog', to: '/blog' },
    ],
  },
  {
    headingKey: 'landing.footer.product',
    links: [
      { labelKey: 'landing.nav.features', href: '/#features' },
      { labelKey: 'publicShell.pricing', to: '/pricing' },
      { labelKey: 'giftLanding.navLink', to: '/gift' },
      { labelKey: 'nav.help', to: '/help' },
    ],
  },
  {
    headingKey: 'landing.footer.company',
    links: [
      { labelKey: 'footer.changelog', to: '/changelog' },
      { labelKey: 'footer.status', to: '/status' },
      { labelKey: 'footer.support', to: '/support' },
      { labelKey: 'landing.footer.contact', href: 'mailto:hello@familygreenhouse.net' },
    ],
  },
  {
    headingKey: 'landing.footer.legal',
    links: [
      { labelKey: 'footer.privacy', to: '/legal/privacy' },
      { labelKey: 'footer.terms', to: '/legal/terms' },
      { labelKey: 'footer.deleteAccount', to: '/account-deletion' },
    ],
  },
];

/**
 * Links the iOS and Android apps leave out. Plans and gifts are purchases, and
 * a link toward buying anywhere but In-App Purchase is a Guideline 3.1.1
 * problem (docs/mobile.md, "Store payment rules"). Inside the apps both
 * routes open Settings → Plan status anyway. The apps have no home page
 * either, so its Features anchor goes too.
 */
const WEB_ONLY_LINKS = new Set(['/pricing', '/gift', '/#features']);

const LINK_CLASS = 'inline-block py-1 text-sm text-primary-200 hover:text-white';

/**
 * The one site footer, on the home page and every public content page (IA
 * decision D2, 2026-11-21): Learn · Product · Company · Legal. Until then the
 * home page had these four groups without Help, Support or Delete account
 * (the Play-required deletion page), and the content pages had one row of
 * links without the pet-safe checker or Contact.
 *
 * The dedication line is intentional and quiet — please leave it. In the
 * iOS and Android apps it lives on Settings → About instead, and nowhere
 * else (owner decision 2026-10-02); the website keeps it here.
 */
export function Footer() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const year = new Date().getFullYear();
  const native = isNativeApp();
  // The Gift link is shown only while the API says a gift can be bought; with
  // no gift price ids set, /gift would only explain that gifts are unavailable.
  const giftsOffered = useGiftAvailability() === 'available';
  const shown = (link: FooterLink) =>
    !(native && WEB_ONLY_LINKS.has(link.to ?? link.href ?? '')) &&
    (link.to !== '/gift' || giftsOffered);
  // On the home page "Features" is an in-page anchor, as it always was there.
  const hrefFor = (href: string) =>
    pathname === '/' && href.startsWith('/#') ? href.slice(1) : href;

  return (
    <footer className="bg-primary-900">
      <div className="mx-auto max-w-7xl px-6 py-12 lg:px-8">
        <nav
          aria-label={t('footer.navLabel')}
          className="grid grid-cols-2 gap-8 sm:grid-cols-3 lg:grid-cols-5"
        >
          <div className="col-span-2 sm:col-span-3 lg:col-span-1">
            <Link to="/" aria-label={t('publicShell.homeLabel', { tagline: t('brand.tagline') })}>
              <BrandMark variant="wordmark" tone="light" />
            </Link>
            <p className="mt-4 text-sm text-primary-200">{t('landing.footer.tagline')}</p>
          </div>
          {FOOTER_GROUPS.map((group) => (
            <div key={group.headingKey}>
              <h2 className="text-sm font-semibold text-white">{t(group.headingKey)}</h2>
              <ul className="mt-3 space-y-1">
                {group.links.filter(shown).map((link) => (
                  <li key={link.labelKey}>
                    {link.to ? (
                      <Link to={link.to} className={LINK_CLASS}>
                        {t(link.labelKey)}
                      </Link>
                    ) : (
                      <a href={hrefFor(link.href!)} className={LINK_CLASS}>
                        {t(link.labelKey)}
                      </a>
                    )}
                  </li>
                ))}
                {group.headingKey === 'landing.footer.legal' && (
                  <AnalyticsOptOutToggle as="li" className="py-1" />
                )}
              </ul>
            </div>
          ))}
        </nav>
        <div className="mt-12 border-t border-primary-700/60 pt-8 text-center">
          <p className="text-sm text-primary-200">{t('footer.copyright', { year })}</p>
          {!native && (
            <div className="mt-6 flex items-center justify-center gap-4">
              <MemorialFrame className="hidden sm:block h-8 w-32 text-primary-300/50" />
              <p className="text-sm italic text-primary-200">{t('footer.memorial')}</p>
              <MemorialFrame className="hidden sm:block h-8 w-32 text-primary-300/50 -scale-x-100" />
            </div>
          )}
          {/* No plant-data credit: Perenual, the provider this line used to
              credit, is switched off in production (license audit, 2026-11-03),
              and no page credits it as a source. */}
        </div>
      </div>
    </footer>
  );
}
