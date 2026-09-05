import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { PLANS, isIntervalOffered, type BillingInterval } from '../../../src/models/plans.js';

/**
 * The Terms of Service are the one plan-status statement in the product that
 * is NOT driven by the catalog.
 *
 * Every other surface closed on its own when #402 withdrew annual billing and
 * the Garden lifetime purchase: `planSummary` publishes a withdrawn cadence as
 * a null price, so `PaidPlanGrid` drops the interval from its toggle, and
 * `POST /billing/checkout` refuses it. `legal.terms.planStatus.body` is prose,
 * so it kept offering both for a month (#600) — on a page whose effective date
 * is the very day they were withdrawn, while real cards were being charged.
 *
 * This is the guard that would have caught it on the day #402 landed. It is
 * deliberately two separate assertions:
 *
 *   1. A PIN on what the catalog sells. It fails whenever a cadence is
 *      withdrawn or brought back, whatever the copy says, so a catalog change
 *      cannot land without someone reading the paragraph below it.
 *   2. A check that the paragraph names each cadence the way the catalog has
 *      it — a cadence that exists but is no longer for sale must be named
 *      *with* its withdrawal, never left standing as an offer. The pre-#600
 *      text ("billed monthly or yearly; Garden is also offered as a one-time
 *      lifetime purchase") named both and marked neither, which is exactly
 *      the shape this rejects.
 *
 * It cannot tell you the prose is *good*. It can tell you the prose still
 * describes the product, which is the property a legal page has to have.
 */

const repositoryRoot = new URL('../../../../', import.meta.url);

const CADENCES = ['month', 'year', 'lifetime'] as const satisfies readonly BillingInterval[];

/** Locales whose legal copy makes this claim. Mirrors LEGAL_LOCALES. */
const LOCALES = ['en', 'es'] as const;

/**
 * How each locale writes a cadence, and how it marks one as withdrawn.
 *
 * `withdrawn` is matched against the same paragraph, not the whole page: the
 * failure being guarded is a cadence offered *in the sentence that lists what
 * is on sale*, so a disclaimer three sections away would not repair it.
 */
const WORDS: Record<
  (typeof LOCALES)[number],
  { cadence: Record<BillingInterval, RegExp>; withdrawn: RegExp }
> = {
  en: {
    cadence: {
      month: /monthly/i,
      year: /yearly|annual/i,
      lifetime: /lifetime/i,
    },
    withdrawn: /no longer (sold|offered|available)|withdrawn from sale/i,
  },
  es: {
    cadence: {
      month: /mensual/i,
      year: /anual/i,
      lifetime: /de por vida/i,
    },
    withdrawn: /ya no (está|están) (a la venta|disponible)|retirad[ao]s? de la venta/i,
  },
};

function planStatusBody(locale: (typeof LOCALES)[number]): string {
  const raw = readFileSync(
    new URL(`frontend/src/i18n/locales/${locale}/legal.json`, repositoryRoot),
    'utf8'
  );
  const body = (JSON.parse(raw) as { legal: { terms: { planStatus: { body: string } } } }).legal
    .terms.planStatus.body;
  expect(body, `${locale} legal.terms.planStatus.body is missing`).toBeTypeOf('string');
  return body;
}

/** Cadences a household could START today, on any tier. */
function cadencesOnSale(): BillingInterval[] {
  return CADENCES.filter((cadence) =>
    Object.values(PLANS).some((plan) => isIntervalOffered(plan, cadence))
  );
}

/** Cadences that exist in the catalog but are withdrawn on every tier that has one. */
function cadencesWithdrawn(): BillingInterval[] {
  const onSale = new Set(cadencesOnSale());
  return CADENCES.filter(
    (cadence) =>
      !onSale.has(cadence) &&
      Object.values(PLANS).some((plan) => plan.withdrawnIntervals?.includes(cadence))
  );
}

describe('Terms of Service plan status matches the plan catalog', () => {
  it('sells exactly the cadences the catalog offers, and the Terms are written for that set', () => {
    expect(
      cadencesOnSale(),
      'The set of billing cadences on sale changed. `legal.terms.planStatus.body` in ' +
        'frontend/src/i18n/locales/{en,es}/legal.json states what is on sale and is not driven ' +
        'by the catalog, so it does not move on its own — rewrite it in both locales in the ' +
        'same change, then update this pin. Withdrawing a cadence also means saying that ' +
        'households already on it keep it (that is what `withdrawnIntervals` exists to ' +
        'preserve), and bringing one back means saying it is sold again.'
    ).toEqual(['month']);

    // The other half of the same fact, so a re-launch and a withdrawal are
    // both visible here rather than only one of them.
    expect(cadencesWithdrawn()).toEqual(['year', 'lifetime']);
  });

  it.each(LOCALES)(
    'names every cadence on sale in the %s Terms, and marks the withdrawn ones as withdrawn',
    (locale) => {
      const body = planStatusBody(locale);
      const { cadence, withdrawn } = WORDS[locale];

      for (const onSale of cadencesOnSale()) {
        expect(
          body,
          `${locale} legal.terms.planStatus.body does not name the '${onSale}' cadence, which ` +
            'the catalog sells. A reader deciding what to buy is told less than checkout offers.'
        ).toMatch(cadence[onSale]);
      }

      for (const gone of cadencesWithdrawn()) {
        expect(
          body,
          `${locale} legal.terms.planStatus.body names the '${gone}' cadence but never says it ` +
            'is no longer sold, so it reads as an offer. Checkout refuses it ' +
            '(isIntervalOffered), and the help page already says it is withdrawn — this ' +
            'paragraph is the one that drifted (#600).'
        ).toMatch(withdrawn);
        // And it must still be named, so the households that hold one can see
        // their arrangement survives rather than reading the omission as loss.
        expect(
          body,
          `${locale} legal.terms.planStatus.body no longer mentions the withdrawn '${gone}' ` +
            'cadence at all. Households still on one need the Terms to say so.'
        ).toMatch(cadence[gone]);
      }
    }
  );
});
