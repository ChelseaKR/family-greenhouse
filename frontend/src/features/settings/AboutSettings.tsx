import { useTranslation } from 'react-i18next';
import { BrandMark } from '@/components/BrandMark';
import { MemorialFrame } from '@/components/brand/MemorialFrame';

/**
 * Settings → About, in the iOS and Android apps only.
 *
 * The memorial line lives here in the apps and nowhere else (owner decision
 * 2026-10-02). On the website it closes every page, in the app shell
 * (Layout.tsx) and the public footer (Footer.tsx); in an app that line
 * repeated under every screen reads as a website's footer, so the apps give
 * it one quiet page of its own. Keep the words exactly as they are, and give
 * them room.
 */
export function AboutSettings() {
  const { t } = useTranslation();
  return (
    <section className="rounded-2xl border border-primary-100 bg-white px-6 py-16 text-center">
      <BrandMark variant="wordmark" size="sm" />
      <MemorialFrame className="mx-auto mt-12 h-8 w-40 text-primary-700/40" />
      <p className="mx-auto mt-6 max-w-xs font-serif text-lg italic leading-8 text-ink">
        {t('footer.memorial')}
      </p>
      <MemorialFrame className="mx-auto mt-6 h-8 w-40 -scale-x-100 text-primary-700/40" />
    </section>
  );
}
