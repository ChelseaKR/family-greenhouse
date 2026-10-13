import { useTranslation } from 'react-i18next';
import { ChevronRightIcon, StarIcon } from '@heroicons/react/24/outline';
import { BrandMark } from '@/components/BrandMark';
import { MemorialFrame } from '@/components/brand/MemorialFrame';
import { getNativePlatform } from '@/lib/platform';
import { APP_STORE_WRITE_REVIEW_URL } from '@/config/site';

/**
 * Settings → About, in the iOS and Android apps only.
 *
 * The memorial line lives here in the apps and nowhere else (owner decision
 * 2026-10-02). On the website it closes every page, in the app shell
 * (Layout.tsx) and the public footer (Footer.tsx); in an app that line
 * repeated under every screen reads as a website's footer, so the apps give
 * it one quiet page of its own. Keep the words exactly as they are, and give
 * them room.
 *
 * In the iOS app, a "Rate Family Greenhouse" row under it opens the App
 * Store's review form (ADR 0036). It is a plain link: the shell hands any
 * outside link to iOS, so it needs no plugin, and nothing is offered for a
 * rating. Android and the website do not show it.
 */
export function AboutSettings() {
  const { t } = useTranslation();
  const ios = getNativePlatform() === 'ios';
  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-primary-100 bg-white px-6 py-16 text-center">
        <BrandMark variant="wordmark" size="sm" />
        <MemorialFrame className="mx-auto mt-12 h-8 w-40 text-primary-700/40" />
        <p className="mx-auto mt-6 max-w-xs font-serif text-lg italic leading-8 text-ink">
          {t('footer.memorial')}
        </p>
        <MemorialFrame className="mx-auto mt-6 h-8 w-40 -scale-x-100 text-primary-700/40" />
      </section>
      {ios && (
        <a
          href={APP_STORE_WRITE_REVIEW_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex min-h-touch items-center gap-3 rounded-2xl border border-primary-100 bg-white px-4 py-3 text-ink hover:bg-primary-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
          data-testid="rate-app-row"
        >
          <StarIcon className="h-5 w-5 shrink-0 text-primary-700" aria-hidden="true" />
          <span className="flex-1">
            <span className="block font-medium">{t('settings.about.rate')}</span>
            <span className="block text-sm text-gray-600">{t('settings.about.rateHint')}</span>
          </span>
          <ChevronRightIcon className="h-5 w-5 shrink-0 text-gray-400" aria-hidden="true" />
        </a>
      )}
    </div>
  );
}
