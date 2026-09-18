import type { TFunction } from 'i18next';

/**
 * Copy for the plans band, keyed by the two gates that decide what may be
 * said there: the repository commercial hold and the registration kill
 * switch. Previously this band branched on registration alone and therefore
 * kept announcing "paid plans are paused" after the hold lifted — directly
 * contradicting the priced catalog rendered underneath it by `PricingGrid`.
 *
 * The words live in the catalogs under `landing.plans.<state>` (#467), so the
 * band reads in the visitor's language; this module only decides which state
 * applies. `footerNote` / `footerLink` stay separate strings because the link
 * sits between them.
 *
 * No amount appears here, and none may: prices come from the API, and the
 * public-surface guard test forbids literal amounts on this surface — in both
 * catalogs. The free-plan caps in `landing.plans.*` are re-derived from
 * plans.ts by scripts/check-plan-copy.mjs.
 */
type PlanBandState = 'open' | 'openRegistrationClosed' | 'held' | 'heldRegistrationClosed';

function planBandState(holdActive: boolean, registrationOpen: boolean): PlanBandState {
  if (holdActive) return registrationOpen ? 'held' : 'heldRegistrationClosed';
  return registrationOpen ? 'open' : 'openRegistrationClosed';
}

export function planBandFor(holdActive: boolean, registrationOpen: boolean, t: TFunction) {
  const state = planBandState(holdActive, registrationOpen);
  return {
    title: t(`landing.plans.${state}.title`),
    description: t(`landing.plans.${state}.description`),
    footerNote: t(`landing.plans.${state}.footerNote`),
    footerLink: t(`landing.plans.${state}.footerLink`),
  };
}
