import { COMMERCIAL_HOLD_ACTIVE, PUBLIC_REGISTRATION_AVAILABLE } from '@/config/commercialStatus';
import { SITE_URL, siteUrl } from '@/config/site';
import { PLAN_PRICES, offeredPrices, type OfferedPrice, type PlanPrice } from './planPrices';

/**
 * Structured data for /pricing.
 *
 * The money page was the only significant route emitting none at all: the
 * homepage publishes Organization + WebSite + SoftwareApplication, the blog and
 * care guides publish Article + BreadcrumbList, and every help topic publishes
 * FAQPage + BreadcrumbList, while the page a search for "family plant app
 * price" should land on published nothing a crawler could read as an offer.
 *
 * The amounts come from `planPrices.ts`, the guarded mirror of the backend
 * catalog — see its comment for why a mirror exists at all and what fails when
 * it drifts. The grid a person reads is still API-sourced.
 */

/** UN/CEFACT codes for the recurring cadences, as schema.org expects them. */
const UNIT_CODE: Record<'month' | 'year', string> = { month: 'MON', year: 'ANN' };

function offerFor(plan: PlanPrice, { interval, amount }: OfferedPrice): Record<string, unknown> {
  const price = amount.toFixed(2);
  const offer: Record<string, unknown> = {
    '@type': 'Offer',
    name: plan.name,
    price,
    priceCurrency: 'USD',
    availability: 'https://schema.org/InStock',
    // The page the offer can be inspected on, not the app's own URL — the
    // SoftwareApplication node below carries that.
    url: siteUrl('/pricing'),
  };
  // A bare `price` says what it costs and not how often. A lifetime purchase
  // is genuinely a one-time amount and needs nothing more; a subscription
  // without this reads as a single charge of $4.99 for the software.
  if (interval !== 'lifetime') {
    offer.priceSpecification = {
      '@type': 'UnitPriceSpecification',
      price,
      priceCurrency: 'USD',
      referenceQuantity: {
        '@type': 'QuantitativeValue',
        value: 1,
        unitCode: UNIT_CODE[interval],
      },
    };
  }
  return offer;
}

/**
 * The offers this page may publish right now.
 *
 * Two gates, both of which exist because an Offer is a promise a crawler will
 * repeat for weeks:
 *
 *  - the commercial hold. While it is on, `PricingGrid` renders the status
 *    notice instead of amounts and checkout refuses every paid cadence, so
 *    naming a paid price here would put a number in front of a buyer that the
 *    product will not take money for. The free tier survives the hold, exactly
 *    as the page's own copy does.
 *  - public registration. If nobody may sign up, the free tier is not on offer
 *    either — the same condition the landing page's free Offer is behind.
 *
 * "Free" is decided by the amount rather than by tier id, so a future free
 * tier is covered without anyone remembering to add it here.
 */
function publishableOffers(): Record<string, unknown>[] {
  return PLAN_PRICES.flatMap((plan) => {
    const free = plan.monthly === 0;
    if (COMMERCIAL_HOLD_ACTIVE && !free) return [];
    if (free && !PUBLIC_REGISTRATION_AVAILABLE) return [];
    return offeredPrices(plan).map((price) => offerFor(plan, price));
  });
}

export function pricingJsonLd(): Record<string, unknown> {
  const offers = publishableOffers();
  return {
    '@context': 'https://schema.org',
    '@graph': [
      // Carried on this page too, so the publisher reference below resolves
      // for a crawler that reaches /pricing without having read the homepage.
      // Same @id, so the two pages describe one organization.
      {
        '@type': 'Organization',
        '@id': `${SITE_URL}/#organization`,
        name: 'Family Greenhouse',
        url: SITE_URL,
        logo: siteUrl('/brand/icon-512.png'),
      },
      {
        '@type': 'SoftwareApplication',
        // The homepage's app node, described again on the page that carries
        // its prices — one application with its offers attached, not a second
        // application that happens to share a name.
        '@id': `${SITE_URL}/#app`,
        name: 'Family Greenhouse',
        applicationCategory: 'LifestyleApplication',
        operatingSystem: 'Web',
        description:
          'A collaborative plant care app for household watering schedules, reminders, tasks, and care logs.',
        url: SITE_URL,
        publisher: { '@id': `${SITE_URL}/#organization` },
        // Deliberately NO aggregateRating. Google's Software App rich result
        // asks for one and this page will very likely render as a plain
        // result without it — but there are no reviews to compute a rating
        // from. The testimonials that used to sit on the landing page were
        // invented and were deleted for exactly that reason
        // (LandingPage.tsx); a fabricated rating is the same invention with a
        // schema wrapper around it, and it is the kind of markup Google
        // issues manual actions for. Add this only when real, sourced reviews
        // exist and something on the page shows them.
        ...(offers.length > 0 ? { offers } : {}),
      },
    ],
  };
}
