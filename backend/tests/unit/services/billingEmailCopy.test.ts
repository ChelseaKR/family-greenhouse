import { describe, expect, it } from 'vitest';
import type { BillingNotice } from '../../../src/models/billingNotices.js';
import { getPlan } from '../../../src/models/plans.js';
import {
  composeAccountDeletionEmail,
  composeBillingEmail,
  formatDate,
  formatMoney,
  type BillingEmailContext,
  type BillingEmailLocale,
} from '../../../src/services/billingEmailCopy.js';

const APP_URL = 'https://familygreenhouse.net/';

function ctx(
  locale: BillingEmailLocale,
  overrides: Partial<BillingEmailContext> = {}
): BillingEmailContext {
  return { locale, timeZone: 'UTC', appUrl: APP_URL, ...overrides };
}

const receipt: Extract<BillingNotice, { kind: 'payment_receipt' }> = {
  kind: 'payment_receipt',
  phase: 'charge',
  householdId: 'hh-1',
  stripeCustomerId: 'cus_1',
  oneTime: false,
  item: { kind: 'plan', planId: 'garden' },
  amount: { minorUnits: 499, currency: 'usd' },
  periodStart: '2026-09-03T00:00:00.000Z',
  periodEnd: '2026-10-03T00:00:00.000Z',
  invoiceUrl: 'https://invoice.stripe.com/i/acct_1/inv_1',
};

const ALL_NOTICES: BillingNotice[] = [
  receipt,
  {
    ...receipt,
    oneTime: true,
    item: { kind: 'identifyCredits', credits: 20 },
    periodStart: null,
    periodEnd: null,
  },
  {
    kind: 'renewal_notice',
    phase: 'charge',
    householdId: 'hh-1',
    stripeCustomerId: 'cus_1',
    amount: { minorUnits: 499, currency: 'usd' },
    renewsAt: '2026-10-03T00:00:00.000Z',
  },
  {
    kind: 'payment_failed',
    phase: 'charge',
    householdId: 'hh-1',
    stripeCustomerId: 'cus_1',
    amount: { minorUnits: 499, currency: 'usd' },
    nextAttempt: { state: 'scheduled', at: '2026-09-06T00:00:00.000Z' },
    invoiceUrl: 'https://invoice.stripe.com/i/acct_1/inv_1',
  },
  {
    kind: 'card_expiring',
    phase: 'charge',
    householdId: null,
    stripeCustomerId: 'cus_1',
    brand: 'Visa',
    last4: '4242',
    expMonth: 9,
    expYear: 2026,
  },
  {
    kind: 'cancellation_scheduled',
    phase: 'state_change',
    householdId: 'hh-1',
    stripeCustomerId: 'cus_1',
    accessUntil: '2026-10-03T00:00:00.000Z',
  },
  {
    kind: 'cancellation_complete',
    phase: 'state_change',
    householdId: 'hh-1',
    stripeCustomerId: 'cus_1',
    endedAt: '2026-10-03T00:00:00.000Z',
  },
];

describe('Intl formatting', () => {
  it('divides minor units by the digits Intl resolves for the currency', () => {
    expect(formatMoney({ minorUnits: 499, currency: 'usd' }, 'en')).toBe('$4.99');
    // Zero-decimal currency: 1200 yen is ¥1,200, not ¥12.
    expect(formatMoney({ minorUnits: 1200, currency: 'jpy' }, 'en')).toBe('¥1,200');
  });

  it('renders Spanish amounts with Spanish separators', () => {
    expect(formatMoney({ minorUnits: 499, currency: 'usd' }, 'es')).toContain('4,99');
    // Grouping too, on a number large enough for es-ES to group it.
    expect(formatMoney({ minorUnits: 1_234_567, currency: 'usd' }, 'es')).toContain('12.345,67');
  });

  it('refuses a malformed currency rather than throwing inside a send', () => {
    expect(formatMoney({ minorUnits: 499, currency: 'dollars' }, 'en')).toBeNull();
  });

  it('renders a date in the recipient timezone, not the server one', () => {
    // 00:30 UTC on the 3rd is still the 2nd in Los Angeles.
    expect(formatDate('2026-10-03T00:30:00.000Z', 'en', 'America/Los_Angeles')).toBe(
      'October 2, 2026'
    );
    expect(formatDate('2026-10-03T00:30:00.000Z', 'en', 'UTC')).toBe('October 3, 2026');
  });

  it('returns null for an unparseable instant instead of Invalid Date', () => {
    expect(formatDate('not-a-date', 'en', 'UTC')).toBeNull();
  });
});

describe('every billing email', () => {
  for (const locale of ['en', 'es'] as const) {
    for (const notice of ALL_NOTICES) {
      it(`${notice.kind} (${locale}) is transactional: no unsubscribe, and says why`, () => {
        const { subject, text } = composeBillingEmail(notice, ctx(locale));
        expect(subject.length).toBeGreaterThan(0);
        // No unsubscribe MECHANISM: no link, no address, nothing to click.
        // The footer names its own absence, which is the point.
        expect(text).not.toMatch(/https?:\/\/\S*unsubscribe/iu);
        expect(text).toMatch(
          locale === 'es' ? /no lleva enlace para darte de baja/u : /no unsubscribe link/u
        );
        expect(text).toContain('https://familygreenhouse.net/settings/billing');
        expect(text).toContain('https://familygreenhouse.net/settings/notifications');
        // The trailing slash on appUrl must not survive into a link.
        expect(text).not.toContain('familygreenhouse.net//');
      });
    }
  }

  it('says something different in Spanish than in English', () => {
    for (const notice of ALL_NOTICES) {
      const en = composeBillingEmail(notice, ctx('en'));
      const es = composeBillingEmail(notice, ctx('es'));
      expect(es.subject).not.toBe(en.subject);
      expect(es.text).not.toBe(en.text);
    }
  });
});

describe('receipt', () => {
  it('states what was bought, the amount and the period', () => {
    const { text } = composeBillingEmail(receipt, ctx('en'));
    expect(text).toContain('Garden plan');
    expect(text).toContain('$4.99');
    expect(text).toContain('September 3, 2026 to October 3, 2026');
  });

  it('names an identification pack in both languages', () => {
    const packReceipt: BillingNotice = {
      ...receipt,
      oneTime: true,
      item: { kind: 'identifyCredits', credits: 20 },
      periodStart: null,
      periodEnd: null,
      invoiceUrl: null,
    };
    expect(composeBillingEmail(packReceipt, ctx('en')).text).toContain('20 plant identifications');
    expect(composeBillingEmail(packReceipt, ctx('es')).text).toContain(
      '20 identificaciones de plantas'
    );
  });

  it("links Stripe's own invoice page when the event carried one", () => {
    expect(composeBillingEmail(receipt, ctx('en')).text).toContain(
      'Full invoice: https://invoice.stripe.com/i/acct_1/inv_1'
    );
    expect(composeBillingEmail({ ...receipt, invoiceUrl: null }, ctx('en')).text).not.toContain(
      'Full invoice:'
    );
  });

  it('says a one-time purchase does not renew', () => {
    const oneTime: BillingNotice = { ...receipt, oneTime: true };
    expect(composeBillingEmail(oneTime, ctx('en')).text).toContain('nothing renews');
    expect(composeBillingEmail(receipt, ctx('en')).text).not.toContain('nothing renews');
  });

  it('NEVER prints a number for an amount it could not read', () => {
    const unreadable: BillingNotice = { ...receipt, amount: null };
    for (const locale of ['en', 'es'] as const) {
      const { text } = composeBillingEmail(unreadable, ctx(locale));
      expect(text).not.toMatch(/[$€£¥]\s?\d/u);
      expect(text).not.toContain('0.00');
      expect(text).not.toContain('0,00');
      expect(text).toMatch(
        locale === 'es' ? /No hemos podido incluir el importe/u : /weren't able to include/u
      );
    }
  });

  it('omits the period entirely rather than half-stating it', () => {
    const halfPeriod: BillingNotice = { ...receipt, periodEnd: null };
    const { text } = composeBillingEmail(halfPeriod, ctx('en'));
    expect(text).not.toContain('Period:');
  });
});

describe('renewal notice', () => {
  it('states the amount, the date, and how to cancel', () => {
    const { text } = composeBillingEmail(ALL_NOTICES[2], ctx('en'));
    expect(text).toContain('$4.99');
    expect(text).toContain('October 3, 2026');
    expect(text).toContain('cancel before that date');
    expect(text).toContain('Manage subscription');
  });

  it('states the amount and cancellation route in Spanish too', () => {
    const { text } = composeBillingEmail(ALL_NOTICES[2], ctx('es'));
    expect(text).toContain('3 de octubre de 2026');
    expect(text).toContain('Gestionar suscripción');
  });
});

describe('payment failed', () => {
  const failed = ALL_NOTICES[3] as Extract<BillingNotice, { kind: 'payment_failed' }>;

  it('names the retry date when Stripe scheduled one', () => {
    expect(composeBillingEmail(failed, ctx('en')).text).toContain(
      "We'll try the card again on September 6, 2026"
    );
  });

  it('says plainly when there will be no further attempt', () => {
    const none: BillingNotice = { ...failed, nextAttempt: { state: 'none' } };
    const { text } = composeBillingEmail(none, ctx('en'));
    expect(text).toContain('last automatic attempt');
    expect(text).not.toContain('try the card again on');
  });

  it('admits it does not know rather than implying either answer', () => {
    const unknown: BillingNotice = { ...failed, nextAttempt: { state: 'unknown' } };
    const { text } = composeBillingEmail(unknown, ctx('en'));
    expect(text).toContain("We don't know whether another automatic attempt is scheduled");
    expect(text).not.toContain('last automatic attempt');
  });

  it('says what happens if it is never paid without claiming a tier it cannot know', () => {
    // Whether a `past_due` household loses its caps immediately depends on a
    // Stripe dashboard setting and on whether PR #364's `getEntitledPlan` has
    // landed. The copy is worded to be true either way.
    const { text } = composeBillingEmail(failed, ctx('en'));
    expect(text).toContain('Stripe stops retrying');
    expect(text).toContain('subscription will not continue');
    expect(text).toContain('Nothing is deleted either way');
    expect(text).not.toContain('moves to the free plan');
    expect(text).not.toContain('keeps its plan');
  });

  it('leads with a direct pay link when Stripe hosted one — the revenue-saving line', () => {
    for (const locale of ['en', 'es'] as const) {
      const { text } = composeBillingEmail(failed, ctx(locale));
      expect(text).toContain('https://invoice.stripe.com/i/acct_1/inv_1');
    }
  });

  it('falls back to the portal, not a broken link, when Stripe hosted none', () => {
    const noLink: BillingNotice = { ...failed, invoiceUrl: null };
    const { text } = composeBillingEmail(noLink, ctx('en'));
    expect(text).toContain('update the card under "Manage subscription"');
    expect(text).not.toContain('invoice.stripe.com');
  });
});

describe('card expiring', () => {
  const expiring = ALL_NOTICES[4] as Extract<BillingNotice, { kind: 'card_expiring' }>;

  it('shows only the digits Stripe sent, and the month it expires', () => {
    const { text } = composeBillingEmail(expiring, ctx('en'));
    expect(text).toContain('Visa ••••4242');
    expect(text).toContain('September 2026');
  });

  it('drops the card description when Stripe sent no card details', () => {
    const noCard: BillingNotice = { ...expiring, brand: null, last4: null };
    const { text } = composeBillingEmail(noCard, ctx('en'));
    expect(text).toContain('The card on file expires at the end of September 2026');
    expect(text).not.toContain('••••');
  });

  it('does not invent an expiry month when it could not be read', () => {
    const noExpiry: BillingNotice = { ...expiring, expMonth: null, expYear: null };
    const { text } = composeBillingEmail(noExpiry, ctx('en'));
    expect(text).toContain('is about to expire');
    expect(text).not.toMatch(/end of \w+ \d{4}/u);
  });
});

describe('cancellation', () => {
  const scheduled = ALL_NOTICES[5] as Extract<BillingNotice, { kind: 'cancellation_scheduled' }>;
  const complete = ALL_NOTICES[6] as Extract<BillingNotice, { kind: 'cancellation_complete' }>;

  it('states what access remains and until when', () => {
    const { text } = composeBillingEmail(scheduled, ctx('en', { currentPlan: getPlan('garden') }));
    expect(text).toContain('You keep the Garden plan until October 3, 2026');
    expect(text).toContain('free Seedling plan');
    expect(text).toContain('Nothing is deleted');
  });

  it('falls back to the paid period rather than inventing a date', () => {
    const noDate: BillingNotice = { ...scheduled, accessUntil: null };
    const { text } = composeBillingEmail(noDate, ctx('en', { currentPlan: getPlan('garden') }));
    expect(text).toContain('until the end of the period you have already paid for');
    expect(text).not.toMatch(/until \w+ \d+, \d{4}/u);
  });

  it('names the tier the household actually holds now, not a guess', () => {
    const { text } = composeBillingEmail(complete, ctx('en', { currentPlan: getPlan('seedling') }));
    expect(text).toContain('Your household is on the Seedling plan');
    expect(text).toContain('20 plants and 3 members');
    expect(text).toContain('You will not be charged again');
  });

  it('says nothing about a plan when the plan is not supplied', () => {
    const { text } = composeBillingEmail(complete, ctx('en'));
    expect(text).not.toContain('Your household is on the');
    expect(text).toContain('Nothing has been deleted');
  });
});

describe('account deletion confirmation', () => {
  it('states what was deleted AND what was retained, in both languages', () => {
    for (const locale of ['en', 'es'] as const) {
      const { subject, text } = composeAccountDeletionEmail(locale, APP_URL, 1, 2);
      expect(subject.length).toBeGreaterThan(0);
      if (locale === 'en') {
        expect(text).toContain('What we deleted:');
        expect(text).toContain('What we did NOT delete, and why:');
        expect(text).toContain('1 household(s) where you were the only member');
        expect(text).toContain('The care history of 2 household(s) you shared');
        expect(text).toContain('name replaced by an anonymous one');
        expect(text).toContain('Stripe, our payment processor, keeps its own record');
        expect(text).toContain('database backups');
        expect(text).toContain('audit log entry');
      } else {
        expect(text).toContain('Lo que hemos borrado:');
        expect(text).toContain('Lo que NO hemos borrado, y por qué:');
        expect(text).toContain('nombre sustituido por uno anónimo');
      }
    }
  });

  it('never claims a household was erased when none was', () => {
    const { text } = composeAccountDeletionEmail('en', APP_URL, 0, 1);
    expect(text).not.toContain('where you were the only member');
    expect(text).not.toContain('cancelled at Stripe');
  });

  it('never claims history was retained when the user shared no household', () => {
    const { text } = composeAccountDeletionEmail('en', APP_URL, 1, 0);
    expect(text).not.toContain('The care history of');
    // The retentions that are true regardless still appear.
    expect(text).toContain('Stripe, our payment processor');
  });

  it('does not overstate erasure and carries no unsubscribe', () => {
    const { text } = composeAccountDeletionEmail('en', APP_URL, 1, 1);
    expect(text.toLowerCase()).not.toContain('unsubscribe');
    expect(text.toLowerCase()).not.toContain('everything has been deleted');
    expect(text.toLowerCase()).not.toContain('all your data has been erased');
  });
});
