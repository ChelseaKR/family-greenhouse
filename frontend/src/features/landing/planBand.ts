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
      'Family Greenhouse is priced per household, not per person. Up to 6 household members share a single plan, and the free tier holds 10 plants with no credit card. Paid plans raise both limits and begin with a 14-day trial.',
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
      'Free accounts include up to 10 plants and 6 household members, with no credit card. Paid plans, purchases, and plan changes remain unavailable.',
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
