import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { MemorialFrame } from './brand/MemorialFrame';
import { AnalyticsOptOutToggle } from './AnalyticsOptOutToggle';

// Labels are catalog keys (#467). Several are shared with the site header and
// the landing footer, so one word is not translated three different ways.
const FOOTER_LINKS = [
  { labelKey: 'nav.help', to: '/help' },
  { labelKey: 'publicShell.careGuides', to: '/care' },
  { labelKey: 'publicShell.blog', to: '/blog' },
  { labelKey: 'publicShell.pricing', to: '/pricing' },
  { labelKey: 'giftLanding.navLink', to: '/gift' },
  { labelKey: 'footer.changelog', to: '/changelog' },
  { labelKey: 'footer.status', to: '/status' },
  { labelKey: 'footer.support', to: '/support' },
  { labelKey: 'footer.privacy', to: '/legal/privacy' },
  { labelKey: 'footer.deleteAccount', to: '/account-deletion' },
  { labelKey: 'footer.terms', to: '/legal/terms' },
];

/** A proper noun, the same in every locale. */
const PLANT_DATA_PROVIDER = 'Perenual';

/**
 * Footer rendered at the bottom of public content pages (via PublicShell).
 * Compact cousin of the landing page's full footer: same dark-green
 * ground, same memorial treatment, plus one row of cross-links so
 * readers arriving from search can find the rest of the site.
 *
 * The dedication line is intentional and quiet — please leave it.
 */
export function Footer() {
  const { t } = useTranslation();
  const year = new Date().getFullYear();
  return (
    <footer className="bg-primary-900">
      <div className="mx-auto max-w-7xl px-6 py-10 text-center">
        <nav
          aria-label={t('footer.navLabel')}
          className="flex flex-wrap justify-center gap-x-6 gap-y-2"
        >
          {FOOTER_LINKS.map((link) => (
            <Link key={link.to} to={link.to} className="text-sm text-primary-200 hover:text-white">
              {t(link.labelKey)}
            </Link>
          ))}
        </nav>
        <AnalyticsOptOutToggle className="mt-4" />
        <div className="mt-8 flex items-center justify-center gap-4">
          <MemorialFrame className="hidden sm:block h-8 w-32 text-primary-300/50" />
          <p className="text-sm italic text-primary-200">{t('footer.memorial')}</p>
          <MemorialFrame className="hidden sm:block h-8 w-32 text-primary-300/50 -scale-x-100" />
        </div>
        <p className="mt-6 text-sm text-primary-200">
          {t('footer.copyrightPlantData', { year })}{' '}
          <a
            href="https://perenual.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-white"
          >
            {PLANT_DATA_PROVIDER}
          </a>
          .
        </p>
      </div>
    </footer>
  );
}
