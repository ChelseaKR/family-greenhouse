/**
 * Money-lifecycle notices, derived from a Stripe webhook event.
 *
 * Pure module: no DynamoDB, no SES, no Stripe client, no clock. It answers one
 * question — "does this event mean something a household's admins are owed an
 * email about, and exactly which facts did the event actually carry?" — so the
 * hard part (what we may honestly claim) is unit-testable against real event
 * payloads without touching anything. Delivery lives in
 * `services/billingEmails.ts`; the copy lives in `services/billingEmailCopy.ts`.
 *
 * ## The rule this module exists to enforce
 *
 * Every field it publishes is `T | null`, and `null` means "the event did not
 * carry this, or carried it in a shape we could not read". It is NEVER a
 * stand-in zero, a stand-in date, or an empty string
 * ([ADR 0010](../../../docs/adr/0010-settled-read-states.md);
 * [ADR 0023](../../../docs/adr/0023-billing-lifecycle-emails.md)). Money is the
 * worst possible place for that defect: a receipt that says `$0.00` because a
 * field was missing is a false statement about a real charge, and a renewal
 * notice with an invented date is a false statement about a future one. The
 * composers therefore render an explicit "we could not include it here, it is
 * on your billing page" sentence rather than a number.
 *
 * The one three-state field is `NextAttempt`, because Stripe genuinely
 * distinguishes "we will retry on this date" from "there will be no further
 * automatic attempt", and collapsing those two into one date-or-nothing would
 * lose the difference that decides what the email tells someone to do.
 */
import type Stripe from 'stripe';
import { isPlanId, type PlanId } from './plans.js';

export type BillingNoticeKind =
  | 'payment_receipt'
  | 'renewal_notice'
  | 'payment_failed'
  | 'card_expiring'
  | 'cancellation_scheduled'
  | 'cancellation_complete';

/**
 * When in `applyStripeEvent` a notice may be dispatched.
 *
 * `charge` — the notice describes a fact that is already true AT STRIPE and is
 * independent of our subscription row (a charge succeeded, an invoice is
 * coming, a payment failed, a card expires). Several of these events carry no
 * subscription delta at all, so they are dispatched before any branch —
 * otherwise the delta short-circuit drops them.
 *
 * `state_change` — the notice describes OUR state changing (a cancellation).
 * Dispatched only after the delta has actually been applied, so the guards
 * that skip an out-of-order or mismatched delivery also skip its email. A
 * household must never be told its plan ended because of an event we then
 * declined to act on.
 */
export type BillingNoticePhase = 'charge' | 'state_change';

/** An amount exactly as Stripe reported it. Both halves read, or no Money. */
export interface Money {
  /** Amount in the currency's minor unit (cents for USD), as Stripe sent it. */
  minorUnits: number;
  /** ISO-4217 code, lower-case, as Stripe sends it. */
  currency: string;
}

/**
 * What a receipt is a receipt FOR.
 *
 * `plan` and `identifyCredits` are read from the metadata WE stamp at checkout,
 * so they survive without expanding line items (which would be a live Stripe
 * API call from inside the webhook). `described` is Stripe's own invoice-line
 * description, which arrives inline on invoice events.
 */
export type PurchasedItem =
  | { kind: 'plan'; planId: PlanId }
  | { kind: 'identifyCredits'; credits: number }
  | { kind: 'described'; description: string };

/**
 * Whether Stripe will try the card again, and when.
 *
 * - `scheduled` — Stripe named a retry instant.
 * - `none`      — Stripe explicitly said there is no further automatic attempt
 *                 (`next_payment_attempt: null`). A REAL value, not a gap.
 * - `unknown`   — the field was absent or unreadable. We say so rather than
 *                 implying either of the above.
 */
export type NextAttempt =
  { state: 'scheduled'; at: string } | { state: 'none' } | { state: 'unknown' };

interface NoticeBase {
  phase: BillingNoticePhase;
  /** Resolved from the event's own metadata; `null` means the dispatcher must
   *  resolve it from the stored Stripe-customer pointer, or send nothing. */
  householdId: string | null;
  stripeCustomerId: string | null;
}

export type BillingNotice =
  | (NoticeBase & {
      kind: 'payment_receipt';
      /** True for a `mode: 'payment'` purchase (a pack, a lifetime tier). */
      oneTime: boolean;
      item: PurchasedItem | null;
      amount: Money | null;
      periodStart: string | null;
      periodEnd: string | null;
      /** Stripe's own hosted invoice page, when the event carried a URL we
       *  recognise as Stripe's. Null for one-time Checkout sessions, which
       *  have no invoice. */
      invoiceUrl: string | null;
    })
  | (NoticeBase & {
      kind: 'renewal_notice';
      amount: Money | null;
      /** Never null: a renewal notice with no date says nothing, so an event
       *  without a readable one produces no notice at all. */
      renewsAt: string;
    })
  | (NoticeBase & {
      kind: 'payment_failed';
      amount: Money | null;
      nextAttempt: NextAttempt;
      /**
       * Stripe's hosted invoice page — the one place a customer can settle
       * this invoice immediately without hunting for the billing portal.
       * This is the highest-value line in the highest-value email here, so it
       * is read straight off the event (no API call) and validated to a
       * Stripe host before it can reach a body. Null when absent or not
       * recognisably Stripe's.
       */
      invoiceUrl: string | null;
    })
  | (NoticeBase & {
      kind: 'card_expiring';
      brand: string | null;
      last4: string | null;
      /** 1-12. Null when unreadable — never a guessed month. */
      expMonth: number | null;
      expYear: number | null;
    })
  | (NoticeBase & {
      kind: 'cancellation_scheduled';
      /** End of the paid period the household has already paid for, when the
       *  event carried it. Null → the copy says "the end of your current
       *  billing period", which is true by definition of the cancellation
       *  Stripe just recorded, and invents no date. */
      accessUntil: string | null;
    })
  | (NoticeBase & {
      kind: 'cancellation_complete';
      endedAt: string | null;
    });

// ---------------------------------------------------------------------------
// Defensive readers. Each returns null for "absent or unreadable"; none of
// them throws, and none of them substitutes a default.
// ---------------------------------------------------------------------------

/** Free text bounded before it can reach an email body. */
const MAX_DESCRIPTION_CHARS = 120;

function readMoney(amount: unknown, currency: unknown): Money | null {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return null;
  if (typeof currency !== 'string' || !/^[a-z]{3}$/i.test(currency)) return null;
  return { minorUnits: Math.round(amount), currency: currency.toLowerCase() };
}

/** A Stripe unix-seconds timestamp as an ISO instant, or null. */
function readInstant(seconds: unknown): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function readCustomerId(value: unknown): string | null {
  if (typeof value === 'string') return readNonEmptyString(value);
  if (value && typeof value === 'object' && 'id' in value) {
    return readNonEmptyString((value as { id?: unknown }).id);
  }
  return null;
}

function readDescription(value: unknown): string | null {
  const text = readNonEmptyString(value);
  if (text === null) return null;
  // Collapse newlines so a multi-line description cannot restructure the body.
  const flattened = text.replace(/\s+/gu, ' ');
  return flattened.length > MAX_DESCRIPTION_CHARS
    ? `${flattened.slice(0, MAX_DESCRIPTION_CHARS - 1)}…`
    : flattened;
}

/**
 * A Stripe-hosted invoice URL, or null.
 *
 * The event is signature-verified before it reaches here, so this is defence
 * in depth rather than the only door — but a URL is the one field in these
 * emails that a reader is invited to click, and "it came from a webhook" is
 * not a reason to print an arbitrary host. Only https, only Stripe.
 */
function readStripeHostedUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    // Not a URL at all. Nothing is read from this and nothing is defaulted:
    // the caller renders no link.
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase();
  return host === 'stripe.com' || host.endsWith('.stripe.com') ? parsed.toString() : null;
}

type Metadata = Record<string, string> | null | undefined;

function householdIdFromMetadata(...sources: Metadata[]): string | null {
  for (const source of sources) {
    const value = readNonEmptyString(source?.householdId);
    if (value !== null) return value;
  }
  return null;
}

/**
 * What a metadata bag says was bought.
 *
 * `planId` is stamped by `billing.createCheckoutSession`. `purchase` +
 * `credits` is the one-time identification pack's metadata contract (PR #415,
 * ADR 0019); it is read here by key rather than by importing that module so
 * this file stays mergeable either side of it — when #415 lands, swap the
 * literal for `IDENTIFY_TOP_UP_PURCHASE_KIND`.
 */
const IDENTIFY_TOP_UP_PURCHASE_KIND = 'identify_top_up';

function purchasedItemFromMetadata(metadata: Metadata): PurchasedItem | null {
  const planId = metadata?.planId;
  if (isPlanId(planId)) return { kind: 'plan', planId };
  if (metadata?.purchase === IDENTIFY_TOP_UP_PURCHASE_KIND) {
    const credits = Number(metadata?.credits);
    // A pack with an unreadable size is a pack we cannot describe. Better a
    // receipt that names only the amount than one that names a made-up count.
    if (Number.isInteger(credits) && credits > 0) return { kind: 'identifyCredits', credits };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Loose views of the Stripe objects. The SDK's types differ across API
// versions (`current_period_end` moved onto the subscription item;
// `subscription_details` moved under `parent`), and this code must survive
// both, so each field is read positionally and validated rather than trusted.
// ---------------------------------------------------------------------------

interface SessionView {
  id?: unknown;
  mode?: unknown;
  payment_status?: unknown;
  amount_total?: unknown;
  currency?: unknown;
  customer?: unknown;
  client_reference_id?: unknown;
  metadata?: Metadata;
}

interface InvoiceLineView {
  description?: unknown;
  metadata?: Metadata;
  period?: { start?: unknown; end?: unknown } | null;
}

interface InvoiceView {
  customer?: unknown;
  hosted_invoice_url?: unknown;
  currency?: unknown;
  amount_paid?: unknown;
  amount_due?: unknown;
  next_payment_attempt?: unknown;
  period_start?: unknown;
  period_end?: unknown;
  metadata?: Metadata;
  subscription_details?: { metadata?: Metadata } | null;
  parent?: { subscription_details?: { metadata?: Metadata } | null } | null;
  lines?: { data?: InvoiceLineView[] } | null;
}

function invoiceHouseholdId(invoice: InvoiceView): string | null {
  return householdIdFromMetadata(
    invoice.subscription_details?.metadata,
    invoice.parent?.subscription_details?.metadata,
    invoice.metadata,
    ...(invoice.lines?.data ?? []).map((line) => line.metadata)
  );
}

function invoiceItem(invoice: InvoiceView): PurchasedItem | null {
  const fromMetadata = purchasedItemFromMetadata(
    invoice.subscription_details?.metadata ??
      invoice.parent?.subscription_details?.metadata ??
      invoice.metadata
  );
  if (fromMetadata) return fromMetadata;
  const description = readDescription(invoice.lines?.data?.[0]?.description);
  return description === null ? null : { kind: 'described', description };
}

// ---------------------------------------------------------------------------
// Per-event classification.
// ---------------------------------------------------------------------------

/**
 * Receipt for a ONE-TIME purchase (`mode: 'payment'`): a lifetime tier, or an
 * identification top-up pack. Subscription checkouts produce no receipt here —
 * theirs comes from `invoice.paid`, which is the event that knows an amount
 * actually moved. Emitting both would send two receipts for one purchase.
 */
function oneTimeReceipt(event: Stripe.Event): BillingNotice | null {
  const session = event.data.object as unknown as SessionView;
  if (session.mode !== 'payment') return null;
  // Deferred payment methods report `unpaid` here and settle later on
  // `checkout.session.async_payment_succeeded`. No money has moved yet.
  if (session.payment_status !== 'paid') return null;
  return {
    kind: 'payment_receipt',
    phase: 'charge',
    oneTime: true,
    householdId:
      householdIdFromMetadata(session.metadata) ?? readNonEmptyString(session.client_reference_id),
    stripeCustomerId: readCustomerId(session.customer),
    item: purchasedItemFromMetadata(session.metadata),
    amount: readMoney(session.amount_total, session.currency),
    periodStart: null,
    periodEnd: null,
    // A one-time Checkout session has no invoice to link to.
    invoiceUrl: null,
  };
}

/**
 * Receipt for a paid subscription invoice.
 *
 * `invoice.paid` only — deliberately NOT `invoice.payment_succeeded`. Stripe
 * emits both for the same money, so handling both would send two receipts for
 * one charge to anyone who subscribes the pair in the dashboard, and the
 * dedupe ledger cannot catch that (two events, two ids, one payment).
 *
 * A zero `amount_paid` sends nothing: every subscription this app creates
 * starts on a 14-day trial, whose first invoice is a real, genuinely-zero
 * invoice. That is a read value of 0, not an unread one, and "you were charged
 * $0.00" is not a receipt anybody wants.
 */
function invoiceReceipt(event: Stripe.Event): BillingNotice | null {
  const invoice = event.data.object as unknown as InvoiceView;
  const amount = readMoney(invoice.amount_paid, invoice.currency);
  if (amount !== null && amount.minorUnits === 0) return null;
  const line = invoice.lines?.data?.[0];
  return {
    kind: 'payment_receipt',
    phase: 'charge',
    oneTime: false,
    householdId: invoiceHouseholdId(invoice),
    stripeCustomerId: readCustomerId(invoice.customer),
    item: invoiceItem(invoice),
    amount,
    periodStart: readInstant(line?.period?.start) ?? readInstant(invoice.period_start),
    periodEnd: readInstant(line?.period?.end) ?? readInstant(invoice.period_end),
    invoiceUrl: readStripeHostedUrl(invoice.hosted_invoice_url),
  };
}

/**
 * Advance notice of a renewal (`invoice.upcoming`). Stripe sends this a
 * configurable number of days before it bills; the window is a dashboard
 * setting, so the email states the date rather than "in three days".
 *
 * No readable date means no notice: "your plan renews" with no when is worse
 * than silence, and inventing one is the defect this whole module guards.
 */
function renewalNotice(event: Stripe.Event): BillingNotice | null {
  const invoice = event.data.object as unknown as InvoiceView;
  const renewsAt = readInstant(invoice.next_payment_attempt) ?? readInstant(invoice.period_end);
  if (renewsAt === null) return null;
  return {
    kind: 'renewal_notice',
    phase: 'charge',
    householdId: invoiceHouseholdId(invoice),
    stripeCustomerId: readCustomerId(invoice.customer),
    amount: readMoney(invoice.amount_due, invoice.currency),
    renewsAt,
  };
}

/** A charge Stripe could not take. The email that saves the subscription. */
function paymentFailed(event: Stripe.Event): BillingNotice | null {
  const invoice = event.data.object as unknown as InvoiceView;
  // Present-and-null is Stripe saying "no further automatic attempt"; absent
  // is us not knowing. The copy says something different for each.
  const raw = invoice.next_payment_attempt;
  const scheduled = readInstant(raw);
  const nextAttempt: NextAttempt =
    scheduled !== null
      ? { state: 'scheduled', at: scheduled }
      : raw === null
        ? { state: 'none' }
        : { state: 'unknown' };
  return {
    kind: 'payment_failed',
    phase: 'charge',
    householdId: invoiceHouseholdId(invoice),
    stripeCustomerId: readCustomerId(invoice.customer),
    amount: readMoney(invoice.amount_due, invoice.currency),
    nextAttempt,
    invoiceUrl: readStripeHostedUrl(invoice.hosted_invoice_url),
  };
}

interface CardView {
  customer?: unknown;
  brand?: unknown;
  last4?: unknown;
  exp_month?: unknown;
  exp_year?: unknown;
}

function readExpMonth(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 12) return null;
  return value;
}

function readExpYear(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 2000 || value > 2200) {
    return null;
  }
  return value;
}

/**
 * A card on file that expires at the end of this month
 * (`customer.source.expiring`).
 *
 * The event carries no household — the object is a Card whose only link is
 * `customer` — so the dispatcher resolves it through the stored
 * Stripe-customer pointer. A household with no pointer yet gets no warning
 * rather than a warning addressed to a guess.
 *
 * Scope, stated rather than implied: Stripe emits this for Card/Source
 * objects. Cards saved as PaymentMethods (which is what Checkout creates
 * today) do not reliably produce it, so this is a best-effort early warning
 * and `invoice.payment_failed` remains the dependable dunning path. Do not
 * present it in the product as complete coverage.
 */
function cardExpiring(event: Stripe.Event): BillingNotice | null {
  const card = event.data.object as unknown as CardView;
  const brand = readNonEmptyString(card.brand);
  const last4 = readNonEmptyString(card.last4);
  const expMonth = readExpMonth(card.exp_month);
  const expYear = readExpYear(card.exp_year);
  // Nothing readable at all: there is no honest sentence left to write.
  if (brand === null && last4 === null && (expMonth === null || expYear === null)) return null;
  return {
    kind: 'card_expiring',
    phase: 'charge',
    householdId: null,
    stripeCustomerId: readCustomerId(card.customer),
    brand,
    last4,
    expMonth,
    expYear,
  };
}

interface SubscriptionView {
  metadata?: Metadata;
  customer?: unknown;
  cancel_at?: unknown;
  cancel_at_period_end?: unknown;
  canceled_at?: unknown;
  ended_at?: unknown;
  current_period_end?: unknown;
  items?: { data?: { current_period_end?: unknown }[] } | null;
}

function subscriptionPeriodEnd(sub: SubscriptionView): string | null {
  return (
    readInstant(sub.current_period_end) ?? readInstant(sub.items?.data?.[0]?.current_period_end)
  );
}

/**
 * The household cancelled, and Stripe is honouring the rest of the paid
 * period: `cancel_at_period_end` moved false → true.
 *
 * Read off `previous_attributes`, which travels with the delivery and is
 * immutable, for the same reason `previousStatusFromEvent` does: the stored
 * row is last-write-wins across an at-least-once stream, so consulting it
 * could conclude a transition this event did not witness. Every other
 * `customer.subscription.updated` — renewals, plan changes, metadata edits —
 * leaves the flag out of the diff and is silent here.
 */
function cancellationScheduled(event: Stripe.Event): BillingNotice | null {
  const previous = (
    event.data as unknown as {
      previous_attributes?: { cancel_at_period_end?: unknown } | null;
    }
  ).previous_attributes;
  if (previous?.cancel_at_period_end !== false) return null;
  const sub = event.data.object as unknown as SubscriptionView;
  if (sub.cancel_at_period_end !== true) return null;
  return {
    kind: 'cancellation_scheduled',
    phase: 'state_change',
    householdId: householdIdFromMetadata(sub.metadata),
    stripeCustomerId: readCustomerId(sub.customer),
    accessUntil: subscriptionPeriodEnd(sub) ?? readInstant(sub.cancel_at),
  };
}

/** The subscription is gone at Stripe. */
function cancellationComplete(event: Stripe.Event): BillingNotice {
  const sub = event.data.object as unknown as SubscriptionView;
  return {
    kind: 'cancellation_complete',
    phase: 'state_change',
    householdId: householdIdFromMetadata(sub.metadata),
    stripeCustomerId: readCustomerId(sub.customer),
    endedAt: readInstant(sub.ended_at) ?? readInstant(sub.canceled_at),
  };
}

/**
 * The notice this event calls for, or null when it calls for none.
 *
 * Every Stripe event type this app subscribes to reaches here; the ones with
 * nothing to say fall through the default. Adding a case means adding the
 * event type to the endpoint's subscription list in
 * `docs/external-services-setup.md`, which `billingNotices.test.ts` asserts.
 */
export function billingNoticeForEvent(event: Stripe.Event): BillingNotice | null {
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      return oneTimeReceipt(event);
    case 'invoice.paid':
      return invoiceReceipt(event);
    case 'invoice.upcoming':
      return renewalNotice(event);
    case 'invoice.payment_failed':
      return paymentFailed(event);
    case 'customer.source.expiring':
      return cardExpiring(event);
    case 'customer.subscription.updated':
      return cancellationScheduled(event);
    case 'customer.subscription.deleted':
      return cancellationComplete(event);
    default:
      return null;
  }
}

/**
 * Stripe event types this module reads. The Stripe endpoint must subscribe
 * every one of them or the corresponding email silently never sends — the
 * "instrumented but dark" failure this repo keeps finding. Exported so the
 * test suite can hold `docs/external-services-setup.md` to it.
 */
export const BILLING_EMAIL_EVENT_TYPES = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'invoice.paid',
  'invoice.upcoming',
  'invoice.payment_failed',
  'customer.source.expiring',
  'customer.subscription.updated',
  'customer.subscription.deleted',
] as const;
