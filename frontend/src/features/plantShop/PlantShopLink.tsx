import { useTranslation } from 'react-i18next';
import { isNativeApp } from '@/lib/platform';
import { resolvePlantShopLink } from './plantShop';

const LINK = 'text-primary-700 underline hover:text-primary-800';

/**
 * "Buy this plant at <shop>", with a visible "Paid link" label beside it and a
 * one-line disclosure under it (ADR 0038). Renders nothing at all — no
 * wrapper, no whitespace — when the plant has no checked product page, when
 * no affiliate program is configured for its shops, or inside the iOS and
 * Android apps, whose privacy labels and review notes this link is kept out
 * of. That makes a build with the config empty byte-identical to one without
 * the feature.
 *
 * Every visible string is a catalog string marked `data-chrome`, so the
 * `/pet-safe/<slug>` build gate (scripts/check-plant-safety-pages.mjs) can
 * account for it, and none of them says anything about the plant.
 */
export function PlantShopLink({ slug }: { slug: string }) {
  const { t } = useTranslation();
  if (isNativeApp()) return null;
  const link = resolvePlantShopLink(slug);
  if (!link) return null;
  const buyKey = `plantShop.buy.${link.merchant}`;

  return (
    <div
      data-plant-shop={slug}
      className="mt-10 rounded-lg border border-primary-100 bg-white px-4 py-3 text-sm text-gray-700"
    >
      <p>
        <a href={link.href} rel="sponsored noopener" data-chrome={buyKey} className={LINK}>
          {t(buyKey)}
        </a>{' '}
        <span
          data-chrome="plantShop.paidLink"
          className="ml-1 rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-800"
        >
          {t('plantShop.paidLink')}
        </span>
      </p>
      <p data-chrome="plantShop.disclosure" className="mt-1 text-xs text-gray-700">
        {t('plantShop.disclosure')}
      </p>
    </div>
  );
}
