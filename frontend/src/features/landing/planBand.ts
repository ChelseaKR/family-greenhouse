/**
 * Copy for the plans band, keyed by the two gates that decide what may be
 * said there: the repository commercial hold and the registration kill
 * switch. Previously this band branched on registration alone and therefore
 * kept announcing "paid plans are paused" after the hold lifted — directly
 * contradicting the priced catalog rendered underneath it by `PricingGrid`.
 *
 * `footerNote` / `footerLink` live here rather than as JSX text so the band
 * can vary with the gates, matching how the rest of the landing page keeps
 * its copy in module-scope blocks.
 *
 * No amount appears here, and none may: prices come from the API, and the
 * public-surface guard test forbids literal amounts on this surface.
 */
const planBandCopy = {
  open: {
    title: 'One plan covers the whole household',
    description:
      'Family Greenhouse is priced per household, not per person. Free is a couple and their plants: one home, up to 3 people and 20 plants, no credit card. Garden is for a household that has to coordinate; Greenhouse is for many homes and many hands. Paid plans begin with a 14-day trial.',
    footerNote: 'Trial terms, cancellation, and how plan changes work are covered in full on the',
    footerLink: 'plans page',
  },
  openRegistrationClosed: {
    title: 'One plan covers the whole household',
    description:
      'Plans are priced per household, not per person, and cover every member who shares your plants. New account registration is paused; existing account holders can still sign in and change plans.',
    footerNote: 'Trial terms, cancellation, and how plan changes work are covered in full on the',
    footerLink: 'plans page',
  },
  held: {
    title: 'Start free; paid plans are paused',
    description:
      'Free accounts include one home, up to 3 household members and 20 plants, with no credit card. Paid plans, purchases, and plan changes remain unavailable.',
    footerNote: 'Read the full',
    footerLink: 'plan-status notice',
  },
  heldRegistrationClosed: {
    title: 'New accounts and paid plans are paused',
    description:
      'Existing account holders can still sign in. New accounts, paid plans, purchases, and plan changes remain unavailable.',
    footerNote: 'Read the full',
    footerLink: 'plan-status notice',
  },
} as const;

export function planBandFor(holdActive: boolean, registrationOpen: boolean) {
  if (holdActive) return registrationOpen ? planBandCopy.held : planBandCopy.heldRegistrationClosed;
  return registrationOpen ? planBandCopy.open : planBandCopy.openRegistrationClosed;
}
