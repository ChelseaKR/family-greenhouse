import affiliateLinks from '@/config/affiliateLinks.json' with { type: 'json' };
import plantShopLinks from './plantShopLinks.json' with { type: 'json' };

/**
 * The optional "Buy this plant" link on the public plant pages (ADR 0038).
 *
 * Two inputs, kept apart on purpose:
 *
 *   - `plantShopLinks.json` is data: one hand-checked product page per plant
 *     and merchant, with the botanical name the merchant's page showed and the
 *     date it was read. No entry means no link; a near match is never listed.
 *   - `config/affiliateLinks.json` is configuration: the Impact tracking link
 *     for each merchant whose affiliate program has approved the account. It
 *     ships empty.
 *
 * A link exists only when both are present. With the config empty, as it is
 * by default, this module answers `null` for every plant, and the pages
 * render exactly what they rendered before the feature existed.
 *
 * The link is a plain URL: no script, no cookie on this site, and no value
 * that varies by reader. The merchant (or Impact) sets its own cookie after
 * the reader leaves.
 */

export const MERCHANTS = ['theSill', 'bloomscape'] as const;
export type Merchant = (typeof MERCHANTS)[number];

export interface PlantShopEntry {
  merchant: Merchant;
  url: string;
  botanicalNameOnPage: string;
  checkedOn: string;
}

export interface PlantShopLink {
  merchant: Merchant;
  /** The merchant's product page, as checked. */
  productUrl: string;
  /** What the anchor points at: the tracking link with the product page as its destination. */
  href: string;
}

export type AffiliateConfig = Partial<Record<Merchant, string>>;

/**
 * An Impact tracking link base: https, a host, then `/c/<publisher>/<ad>/<campaign>`
 * and nothing after it (no query, no fragment). Anything else is treated as
 * unset, so a mistyped value renders no link rather than a broken one;
 * `plantShop.test.ts` fails the build if the committed config is not empty
 * or of this form.
 */
export const IMPACT_TRACKING_LINK = /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+\/c\/\d+\/\d+\/\d+$/;

/** True when `value` is a usable tracking link base. */
export function isTrackingLink(value: unknown): value is string {
  return typeof value === 'string' && IMPACT_TRACKING_LINK.test(value);
}

/** The anchor's href: Impact's deep link, `?u=` the merchant's own product page. */
export function affiliateHref(trackingLink: string, productUrl: string): string {
  return `${trackingLink}?u=${encodeURIComponent(productUrl)}`;
}

const ENTRIES = (plantShopLinks as { links: Record<string, PlantShopEntry[]> }).links;

/**
 * The link for `slug`, or null. Merchants are tried in `MERCHANTS` order, so a
 * plant listed at both shops goes to the first one whose program is active.
 */
export function resolvePlantShopLink(
  slug: string,
  config: AffiliateConfig = affiliateLinks as AffiliateConfig,
  entries: Record<string, PlantShopEntry[]> = ENTRIES
): PlantShopLink | null {
  const listed = Object.hasOwn(entries, slug) ? entries[slug]! : [];
  for (const merchant of MERCHANTS) {
    const trackingLink = config[merchant];
    if (!isTrackingLink(trackingLink)) continue;
    const entry = listed.find((e) => e.merchant === merchant);
    if (!entry) continue;
    return {
      merchant,
      productUrl: entry.url,
      href: affiliateHref(trackingLink, entry.url),
    };
  }
  return null;
}

/**
 * Whether a `/pet-safe/<slug>` page may carry the link: only when it shows a
 * verdict for every animal and each one is a cited "non-toxic". A page that
 * tells a reader a plant is toxic to their pet, or that it cannot say, never
 * also offers to sell them the plant. The care guides carry the link either
 * way: their reader already has the plant or has chosen it, and the toxicity
 * section there stays exactly as sourced. scripts/check-plant-safety-pages.mjs
 * applies the same rule to the built pages.
 */
export function offersShopLink(claims: ReadonlyArray<{ state: string }>): boolean {
  return claims.length > 0 && claims.every((claim) => claim.state === 'non-toxic');
}
