import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type Stripe from 'stripe';
import {
  BILLING_EMAIL_EVENT_TYPES,
  billingNoticeForEvent,
} from '../../../src/models/billingNotices.js';

/** Minimal Stripe.Event envelope; each test supplies the object it cares about. */
function event(
  type: string,
  object: Record<string, unknown>,
  previousAttributes?: Record<string, unknown>
): Stripe.Event {
  return {
    id: 'evt_1',
    object: 'event',
    api_version: '2024-06-20',
    created: 1_756_000_000,
    livemode: false,
    pending_webhooks: 0,
    request: null,
    type,
    data: { object, ...(previousAttributes ? { previous_attributes: previousAttributes } : {}) },
  } as unknown as Stripe.Event;
}

describe('billingNoticeForEvent — one-time purchase receipts', () => {
  it('receipts a paid one-time checkout, naming the plan from our own metadata', () => {
    const notice = billingNoticeForEvent(
      event('checkout.session.completed', {
        id: 'cs_1',
        mode: 'payment',
        payment_status: 'paid',
        amount_total: 14900,
        currency: 'usd',
        customer: 'cus_1',
        metadata: { householdId: 'hh-1', planId: 'garden', interval: 'lifetime' },
      })
    );
    expect(notice).toMatchObject({
      kind: 'payment_receipt',
      phase: 'charge',
      oneTime: true,
      householdId: 'hh-1',
      stripeCustomerId: 'cus_1',
      item: { kind: 'plan', planId: 'garden' },
      amount: { minorUnits: 14900, currency: 'usd' },
    });
  });

  it('receipts a one-time identification pack from the shared metadata contract', () => {
    const notice = billingNoticeForEvent(
      event('checkout.session.async_payment_succeeded', {
        id: 'cs_2',
        mode: 'payment',
        payment_status: 'paid',
        amount_total: 199,
        currency: 'usd',
        client_reference_id: 'hh-2',
        metadata: { purchase: 'identify_top_up', packId: 'identify-20', credits: '20' },
      })
    );
    expect(notice).toMatchObject({
      kind: 'payment_receipt',
      oneTime: true,
      householdId: 'hh-2',
      item: { kind: 'identifyCredits', credits: 20 },
    });
  });

  it('does not invent a pack size when the credits metadata is unreadable', () => {
    const notice = billingNoticeForEvent(
      event('checkout.session.completed', {
        id: 'cs_3',
        mode: 'payment',
        payment_status: 'paid',
        amount_total: 199,
        currency: 'usd',
        metadata: { householdId: 'hh-3', purchase: 'identify_top_up', credits: 'twenty' },
      })
    );
    // Still a receipt — the money moved — but with no claim about what it bought.
    expect(notice).toMatchObject({ kind: 'payment_receipt', item: null });
  });

  it('stays silent until a deferred payment method actually pays', () => {
    expect(
      billingNoticeForEvent(
        event('checkout.session.completed', {
          id: 'cs_4',
          mode: 'payment',
          payment_status: 'unpaid',
          amount_total: 14900,
          currency: 'usd',
          metadata: { householdId: 'hh-4', planId: 'garden' },
        })
      )
    ).toBeNull();
  });

  it('leaves subscription checkouts to invoice.paid, so one purchase is one receipt', () => {
    expect(
      billingNoticeForEvent(
        event('checkout.session.completed', {
          id: 'cs_5',
          mode: 'subscription',
          payment_status: 'paid',
          amount_total: 499,
          currency: 'usd',
          metadata: { householdId: 'hh-5', planId: 'garden' },
        })
      )
    ).toBeNull();
  });
});

describe('billingNoticeForEvent — subscription receipts', () => {
  const paidInvoice = {
    customer: 'cus_9',
    currency: 'usd',
    hosted_invoice_url: 'https://invoice.stripe.com/i/acct_9/inv_9',
    amount_paid: 499,
    period_start: 1_756_000_000,
    period_end: 1_758_592_000,
    subscription_details: { metadata: { householdId: 'hh-9', planId: 'garden' } },
    lines: {
      data: [
        {
          description: 'Garden × 1 month',
          period: { start: 1_756_000_000, end: 1_758_592_000 },
        },
      ],
    },
  };

  it('receipts a paid subscription invoice with its amount and covered period', () => {
    const notice = billingNoticeForEvent(event('invoice.paid', paidInvoice));
    expect(notice).toMatchObject({
      kind: 'payment_receipt',
      oneTime: false,
      householdId: 'hh-9',
      item: { kind: 'plan', planId: 'garden' },
      amount: { minorUnits: 499, currency: 'usd' },
      periodStart: '2025-08-24T01:46:40.000Z',
      periodEnd: '2025-09-23T01:46:40.000Z',
      invoiceUrl: 'https://invoice.stripe.com/i/acct_9/inv_9',
    });
  });

  it('refuses an invoice URL that is not https on a Stripe host', () => {
    for (const url of [
      'http://invoice.stripe.com/i/acct_9/inv_9',
      'https://invoice.stripe.com.evil.test/i/x',
      'https://example.com/pay',
      'javascript:alert(1)',
      'not a url',
      '',
    ]) {
      expect(
        billingNoticeForEvent(event('invoice.paid', { ...paidInvoice, hosted_invoice_url: url })),
        url
      ).toMatchObject({ invoiceUrl: null });
    }
  });

  it('finds the household when Stripe nests subscription metadata under parent', () => {
    const notice = billingNoticeForEvent(
      event('invoice.paid', {
        ...paidInvoice,
        subscription_details: undefined,
        parent: { subscription_details: { metadata: { householdId: 'hh-nested' } } },
      })
    );
    expect(notice).toMatchObject({ householdId: 'hh-nested' });
  });

  it('sends nothing for a genuinely zero invoice (every plan starts on a trial)', () => {
    expect(
      billingNoticeForEvent(event('invoice.paid', { ...paidInvoice, amount_paid: 0 }))
    ).toBeNull();
  });

  it('reports an unreadable amount as null, never as zero', () => {
    const notice = billingNoticeForEvent(
      event('invoice.paid', { ...paidInvoice, currency: undefined })
    );
    expect(notice).toMatchObject({ kind: 'payment_receipt', amount: null });
  });

  it('reports an unreadable period as null, never as the epoch', () => {
    const notice = billingNoticeForEvent(
      event('invoice.paid', {
        ...paidInvoice,
        period_start: null,
        period_end: 'soon',
        lines: { data: [{ description: 'Garden × 1 month', period: null }] },
      })
    );
    expect(notice).toMatchObject({ periodStart: null, periodEnd: null });
  });

  it('falls back to the invoice line description when no plan metadata is stamped', () => {
    const notice = billingNoticeForEvent(
      event('invoice.paid', {
        ...paidInvoice,
        subscription_details: { metadata: { householdId: 'hh-9' } },
      })
    );
    expect(notice).toMatchObject({ item: { kind: 'described', description: 'Garden × 1 month' } });
  });

  it('flattens and bounds a hostile invoice-line description', () => {
    const notice = billingNoticeForEvent(
      event('invoice.paid', {
        ...paidInvoice,
        subscription_details: { metadata: { householdId: 'hh-9' } },
        lines: { data: [{ description: `line one\nline two${'x'.repeat(400)}` }] },
      })
    );
    const described = notice as { item: { kind: string; description: string } };
    expect(described.item.description).not.toContain('\n');
    expect(described.item.description.length).toBeLessThanOrEqual(120);
  });

  it('ignores invoice.payment_succeeded so a doubled subscription cannot double-receipt', () => {
    expect(billingNoticeForEvent(event('invoice.payment_succeeded', paidInvoice))).toBeNull();
  });
});

describe('billingNoticeForEvent — renewal notice', () => {
  it('names the renewal date and amount', () => {
    const notice = billingNoticeForEvent(
      event('invoice.upcoming', {
        customer: 'cus_1',
        currency: 'usd',
        amount_due: 499,
        next_payment_attempt: 1_758_592_000,
        subscription_details: { metadata: { householdId: 'hh-1' } },
      })
    );
    expect(notice).toMatchObject({
      kind: 'renewal_notice',
      phase: 'charge',
      renewsAt: '2025-09-23T01:46:40.000Z',
      amount: { minorUnits: 499, currency: 'usd' },
    });
  });

  it('sends nothing rather than a renewal notice with no date', () => {
    expect(
      billingNoticeForEvent(
        event('invoice.upcoming', {
          customer: 'cus_1',
          currency: 'usd',
          amount_due: 499,
          next_payment_attempt: null,
          period_end: null,
        })
      )
    ).toBeNull();
  });
});

describe('billingNoticeForEvent — payment failed', () => {
  const base = {
    customer: 'cus_1',
    currency: 'usd',
    amount_due: 499,
    subscription_details: { metadata: { householdId: 'hh-1' } },
  };

  it('carries the Stripe-hosted invoice page, the one link that recovers the money', () => {
    expect(
      billingNoticeForEvent(
        event('invoice.payment_failed', {
          ...base,
          next_payment_attempt: 1_758_592_000,
          hosted_invoice_url: 'https://invoice.stripe.com/i/acct_1/inv_1',
        })
      )
    ).toMatchObject({ invoiceUrl: 'https://invoice.stripe.com/i/acct_1/inv_1' });
  });

  it('carries the scheduled retry when Stripe named one', () => {
    expect(
      billingNoticeForEvent(
        event('invoice.payment_failed', { ...base, next_payment_attempt: 1_758_592_000 })
      )
    ).toMatchObject({
      kind: 'payment_failed',
      nextAttempt: { state: 'scheduled', at: '2025-09-23T01:46:40.000Z' },
    });
  });

  it('distinguishes "no further attempt" from "we do not know"', () => {
    expect(
      billingNoticeForEvent(
        event('invoice.payment_failed', { ...base, next_payment_attempt: null })
      )
    ).toMatchObject({ nextAttempt: { state: 'none' } });

    expect(billingNoticeForEvent(event('invoice.payment_failed', base))).toMatchObject({
      nextAttempt: { state: 'unknown' },
    });
  });
});

describe('billingNoticeForEvent — card expiring', () => {
  it('carries only the card details Stripe actually sent', () => {
    expect(
      billingNoticeForEvent(
        event('customer.source.expiring', {
          object: 'card',
          customer: 'cus_7',
          brand: 'Visa',
          last4: '4242',
          exp_month: 9,
          exp_year: 2026,
        })
      )
    ).toMatchObject({
      kind: 'card_expiring',
      householdId: null,
      stripeCustomerId: 'cus_7',
      brand: 'Visa',
      last4: '4242',
      expMonth: 9,
      expYear: 2026,
    });
  });

  it('refuses an out-of-range month rather than rendering it', () => {
    expect(
      billingNoticeForEvent(
        event('customer.source.expiring', {
          customer: 'cus_7',
          brand: 'Visa',
          last4: '4242',
          exp_month: 13,
          exp_year: 2026,
        })
      )
    ).toMatchObject({ expMonth: null });
  });

  it('sends nothing when there is no honest sentence left to write', () => {
    expect(
      billingNoticeForEvent(event('customer.source.expiring', { customer: 'cus_7' }))
    ).toBeNull();
  });
});

describe('billingNoticeForEvent — cancellations', () => {
  it('fires only on the false → true cancel_at_period_end transition', () => {
    const sub = {
      metadata: { householdId: 'hh-1' },
      customer: 'cus_1',
      cancel_at_period_end: true,
      items: { data: [{ current_period_end: 1_758_592_000 }] },
    };
    expect(
      billingNoticeForEvent(
        event('customer.subscription.updated', sub, { cancel_at_period_end: false })
      )
    ).toMatchObject({
      kind: 'cancellation_scheduled',
      phase: 'state_change',
      accessUntil: '2025-09-23T01:46:40.000Z',
    });
  });

  it('is silent for a renewal, a plan change, and a metadata edit', () => {
    const sub = { metadata: { householdId: 'hh-1' }, cancel_at_period_end: false };
    expect(billingNoticeForEvent(event('customer.subscription.updated', sub, {}))).toBeNull();
    expect(
      billingNoticeForEvent(event('customer.subscription.updated', sub, { status: 'trialing' }))
    ).toBeNull();
    expect(billingNoticeForEvent(event('customer.subscription.updated', sub))).toBeNull();
  });

  it('confirms a completed cancellation with the end date the event carried', () => {
    expect(
      billingNoticeForEvent(
        event('customer.subscription.deleted', {
          metadata: { householdId: 'hh-1' },
          customer: 'cus_1',
          ended_at: 1_758_592_000,
        })
      )
    ).toMatchObject({
      kind: 'cancellation_complete',
      phase: 'state_change',
      endedAt: '2025-09-23T01:46:40.000Z',
    });
  });
});

describe('billingNoticeForEvent — everything else', () => {
  it('has nothing to say about an event type it does not read', () => {
    expect(billingNoticeForEvent(event('customer.subscription.created', {}))).toBeNull();
    expect(billingNoticeForEvent(event('payment_intent.succeeded', {}))).toBeNull();
  });
});

describe('the Stripe endpoint subscription list', () => {
  // An email whose event type is not subscribed is instrumented and dark:
  // the code is correct, the mail never sends, and nothing anywhere says so.
  // `docs/external-services-setup.md` is the only place the endpoint's event
  // list is written down, so it is held to the code here.
  it('documents every event type the notice model reads', () => {
    const setup = readFileSync(
      resolve(import.meta.dirname, '../../../../docs/external-services-setup.md'),
      'utf8'
    );
    for (const type of BILLING_EMAIL_EVENT_TYPES) {
      expect(setup, `docs/external-services-setup.md must list ${type}`).toContain(`\`${type}\``);
    }
  });
});
