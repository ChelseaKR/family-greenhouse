# 0023 — Billing lifecycle emails: transactional, idempotent, and never a number we did not read

**Status:** Accepted

**Date:** 2026-09-03

**Deciders:** Chelsea Kelly-Reif

**Related:** [ADR 0010](0010-settled-read-states.md) (a settled read with no data is
its own state), [ADR 0012](0012-plant-id-unit-cost-withdraws-annual-and-lifetime.md)
(the cadences still on sale)

## Context

Paid plans are live and the product sent **no billing email at all**. An email
audit of `main` found five app emails, every one of them about plants: a care
reminder, a weekly digest, an annual recap, a pest alert and a welcome. Nothing
told anyone that money had moved.

Concretely, a household could be charged $4.99 a month, have its card decline,
lose its subscription, and delete its account, and receive not one message from
us about any of it. Stripe's own dashboard-side receipts can cover part of the
first case if someone enables them, but they are Stripe's voice, they cannot
speak about entitlement, and nothing in this repository knows whether they are
switched on.

Two of the gaps are more than a trust problem:

- **A renewal notice.** Every subscription this app creates carries
  `trial_period_days: 14` (`services/billing.ts`), so every subscriber is a
  free-trial-to-paid conversion. California's Automatic Renewal Law
  (Cal. Bus. & Prof. Code § 17600 _et seq._, as amended) requires a reminder
  before a free trial converts to a paid charge, in a window measured in days
  before the charge, and a post-purchase acknowledgement carrying the renewal
  terms and how to cancel. The EU Consumer Rights Directive (2011/83/EU, Art. 8)
  separately expects confirmation of the contract on a durable medium including
  the total price.
- **A cancellation confirmation.** The same regime expects a cancellation to be
  acknowledged and the remaining access period stated.

Neither existed. (This ADR is engineering reasoning, not legal advice; the
owner should confirm the exact windows against current law for the states and
countries actually being sold into. The point recorded here is that these two
emails are compliance surface, not polish, and should not be removed casually.)

A fourth force: `DELETE /me` has a documented caveat — it "removes login +
personal data but preserves household _activity history_ under a pseudonymized
member name" (`docs/compliance.md` §3) — and nothing confirmed the deletion or
disclosed the caveat at the moment a person is actually reading.

## Decision

Six emails, five of them triggered from the existing Stripe webhook path and
one from `DELETE /me`, built in three modules: `models/billingNotices.ts`
(pure: what an event means and which facts it carried),
`services/billingEmailCopy.ts` (pure: what to say, in `en` and `es`), and
`services/billingEmails.ts` (who gets it, exactly once, over SES).

### 1. All six are transactional. None is marketing.

| Email                                   | Trigger                                                  | Class         |
| --------------------------------------- | -------------------------------------------------------- | ------------- |
| Payment receipt                         | `invoice.paid`, and a paid one-time `checkout.session.*` | transactional |
| Renewal notice                          | `invoice.upcoming`                                       | transactional |
| Payment failed                          | `invoice.payment_failed`                                 | transactional |
| Card expiring                           | `customer.source.expiring`                               | transactional |
| Cancellation (scheduled, and completed) | `customer.subscription.updated` / `.deleted`             | transactional |
| Account deletion confirmation           | `DELETE /me`                                             | transactional |

The line matters because it decides three things at once.

**Gating.** None of these is gated on `notificationPrefs.email`,
`weeklyDigest`, `pestAlerts`, or the do-not-disturb window. A person who turned
off plant reminders has not consented to being charged silently, and a quiet
hour is not a reason to delay telling someone their card failed. The prefs row
is read for exactly one field, `timezone`, so dates render in the zone the
account already uses for quiet hours; nothing on that row can suppress a send.

**Unsubscribe.** They carry no unsubscribe link and no `List-Unsubscribe`
header. Under CAN-SPAM the opt-out duty attaches to mail whose primary purpose
is commercial advertisement, and "transactional or relationship" content —
which a receipt for a charge already made, and a notice about an existing
subscription, plainly is — is treated differently. The Gmail/Yahoo bulk-sender
rules that require one-click unsubscribe are likewise aimed at bulk and
promotional mail. Adding an unsubscribe control to a payment-failure notice
would offer someone a switch that we would then have to ignore, which is worse
than not offering it.

Absence alone reads as an oversight, so each of these emails **says so**: a
short footer states that it is a billing message, that it is sent whatever the
notification settings say because it concerns money and access, and links to
the notification settings anyway. The account-deletion confirmation says
instead that it is the last message we will send, because the preferences it
would otherwise point at have just been erased.

This is the opposite call from the weekly digest and the annual recap, which
_are_ lifecycle/engagement mail and _do_ need an unsubscribe path. That gap is
real and is not addressed here.

**Deliverability.** Everything goes through `emailNotifier.sendEmail`
unmodified. Nothing in this change reaches SES directly, so whatever lands in
that wrapper — a configuration set, bounce and complaint suppression, a
multipart HTML alternative — applies to these emails the moment it exists,
with no edit here.

### 2. Idempotency: the existing ledger partition, a separate sort key, per recipient

Stripe guarantees at-least-once delivery and no ordering. A duplicate receipt
is not a cosmetic bug: it makes a customer believe they were charged twice, and
the support conversation that follows costs more than the subscription.

Each send takes a marker in the **existing** Stripe-event ledger partition,
`PK: STRIPE_EVENT#{eventId}`, under its own sort key `EMAIL#{kind}#{userId}`.

The separate sort key is required, not tidiness. The ledger's `METADATA` row is
deliberately written **after** the subscription apply, so that a failed apply
stays retryable (`billing.recordStripeEventOnce` documents this). If an email
claimed that same row before sending, a failed apply would meet its own
"already processed" marker on Stripe's retry and be dropped forever. A DynamoDB
conditional put is evaluated against the exact PK+SK, so a second sort key in
the same partition dedupes the email without touching that contract, and the
30-day TTL ages the whole partition out together.

Keying **per recipient** means a household with two admins gets exactly one
email each: if one send fails, the redelivery re-mails only the admin who
missed out.

The claim/send/finalize lease is the shape `welcomeEmail` already uses. A
failed send or a dry run (SES unconfigured) releases the slot so a redelivery
or a manual dashboard resend can still deliver; a confirmed SES send never
reopens it, because reopening would guarantee a duplicate on the next
redelivery.

**Dispatch never throws.** A 5xx from the webhook makes Stripe redeliver the
whole event, which re-runs a subscription apply and, for a lifetime purchase, a
Stripe subscription cancellation. An undelivered email is not worth that. The
cost is that a transient SES failure is logged rather than automatically
retried; the released marker means a resend from the Stripe dashboard fixes it.

### 3. Two dispatch phases, because a cancellation is our claim and a charge is Stripe's

`applyStripeEvent` calls the dispatcher twice.

- **`charge`**, as the first statement, before any branch. A receipt, a renewal
  notice, a payment failure and a card expiry all describe a fact that is
  already true at Stripe and independent of our row — and several of their
  events (`invoice.*`, `customer.source.expiring`) produce no subscription
  delta, so the existing `if (!delta) return` would drop them. Running first
  also means a one-time purchase handled by an earlier `return` still gets its
  receipt.
- **`state_change`**, after the delta has been applied. The cancellation
  confirmations assert something about _our_ state, so they sit downstream of
  every guard that can decline an event: the out-of-order guard, the
  subscription-mismatch guard, the completed-lifetime guard. A household must
  never be told its plan ended because of a delivery we then declined to act
  on.

### 4. Never state an amount, a date or a card detail read from a failed lookup

This repository's named defect class ([ADR 0010](0010-settled-read-states.md)),
applied where it does the most damage. Every field `models/billingNotices.ts`
publishes is `T | null`; `null` means the event did not carry it or carried it
unreadably, and the composers then **omit the sentence** or say plainly that
the amount is on the billing page. Specifically:

- A receipt with an unreadable amount is still sent — the charge happened and
  the customer is owed the news — but it prints no number at all.
- A renewal notice with no readable date is **not sent**. "Your plan renews"
  with no when is worse than silence, and a guessed date is worse than both.
- `next_payment_attempt` is three-state: a scheduled retry, an explicit "no
  further automatic attempt" (Stripe's `null`), and "we could not read it".
  Collapsing the last two would tell someone the retries were over when we did
  not know that.
- A zero `amount_paid` sends nothing. Every subscription starts on a 14-day
  trial whose first invoice is a genuine zero; that is a value we read, not one
  we missed, and "you were charged $0.00" is not a receipt.
- Amounts go through `Intl.NumberFormat` with the currency Stripe reported,
  dividing minor units by the fraction digits `Intl` itself resolves — so a
  zero-decimal currency is not silently divided by 100. Dates go through
  `Intl.DateTimeFormat` in the recipient's stored timezone. No string
  concatenation, per `docs/i18n.md`.

### 4a. The payment-failure email is the one that recovers money, so it links Stripe's invoice page

Every other email here informs. This one has a job. Two decisions follow from
that.

**It carries `hosted_invoice_url`.** Stripe puts the hosted invoice page on the
`invoice.payment_failed` event itself, so the email can offer a one-click "pay
this now, change the card here" destination without a single API call. That is
strictly better than sending someone to our billing page, then the portal, then
Stripe. The URL is read off the event and then **validated** — https only, and
only a `stripe.com` host — before it can reach a body: the event is
signature-verified, but a URL is the one field a reader is invited to click,
and "it came from a webhook" is not a reason to print an arbitrary host. An
absent or unrecognised URL falls back to the portal instruction rather than
rendering a broken link.

**It does not claim a tier transition it cannot verify.** What happens to
entitlement when an invoice goes unpaid depends on two things this repository
does not control: Stripe's "subscription status after all retries fail" setting
(cancel / mark unpaid / leave `past_due`), and whether entitlement consults
`subscription.status` at all — today it does not, so a household left `unpaid`
keeps its paid caps until the subscription is actually deleted. PR #364 changes
that by resolving caps through `getEntitledPlan`. Rather than pick a side, the
copy states only what is true under every combination: Stripe will stop
retrying, the subscription will not continue, and nothing the household created
is deleted whatever plan it ends up on. When #364 lands, this copy is still
correct; if the dashboard setting changes, it is still correct.

### 5. Recipients are the household's admins

Only an admin can reach checkout or the billing portal (`requireAdmin` on
both), so they are the only people who can act on any of these, and payment
details are not the whole household's business. Recipients come from **our**
member roster, not from the address Stripe holds, so a billing email never goes
anywhere the household has not put on its own member list. A household with no
admin address logs `billing_email_no_recipient` and sends nothing.

### 6. The account-deletion confirmation states what was retained

It lists, in the same email and at the same weight: the login and preferences
that were deleted; households erased outright because the user was their only
member, counted from the work actually done; the shared care history that was
**kept** under a pseudonym and why; that Stripe holds its own record of
payments already made; that the table's point-in-time recovery means backups
still contain earlier data for their retention window; and that an audit log
records the deletion. It is sent only after every destructive step has
succeeded, so it can never promise a deletion that failed halfway, and it
writes **no delivery marker** — a marker would re-create a row in the
`USER#{id}` partition the same request just erased.

## Consequences

- **Two Terraform changes and a manual Stripe step are required before any of
  this sends.** The `billing` and `me` Lambdas had no `SES_FROM_EMAIL`, so
  every one of these emails would have been a permanent dry run — instrumented
  and dark. The Terraform is written; the apply is an owner action. The four
  new webhook event types (`invoice.paid`, `invoice.upcoming`,
  `invoice.payment_failed`, `customer.source.expiring`) must be subscribed in
  the Stripe dashboard: there is no Stripe Terraform provider in this
  repository, so the endpoint's event list cannot be codified. What CI can do,
  and now does, is fail if the notice model reads an event type that
  `docs/external-services-setup.md` does not name.
- **`invoice.payment_succeeded` is deliberately unhandled.** Stripe emits it
  alongside `invoice.paid` for the same money. Handling both would send two
  receipts for one charge to anyone who subscribes the pair, and the dedupe
  ledger cannot merge them — two events, two ids, one payment.
- **The card-expiring warning is best-effort and must be described that way.**
  `customer.source.expiring` fires for Card/Source objects; cards saved as
  PaymentMethods, which is what Checkout creates, do not reliably produce it.
  `invoice.payment_failed` remains the dependable dunning path.
- **A new row type.** `STRIPE_CUSTOMER#{id} → householdId`, written by any
  notice that knows both ids and read by the ones that know only a customer.
  It carries a 400-day TTL and is refreshed on every receipt. A household whose
  pointer has not been learned yet gets no card-expiring warning — which is the
  intended behaviour, since the alternative is mail addressed to a guess.
- **Locale is a parameter, not yet a lookup.** The backend still has no
  per-user locale field; `feat/useful-emails` owns adding one. Both catalogs
  are written and tested, and adopting the field is a one-line change at each
  call site. Until then every send is `en`.
- **Dates render in the account's stored timezone, which defaults to `UTC`.**
  A household that never pressed "Save quiet hours" therefore sees UTC dates —
  the same trap the help content already documents for the DND window, now
  visible in one more place. Fixing it once fixes it for both.
- **Renewal-notice lead time is a Stripe dashboard setting, not ours.** How
  far ahead `invoice.upcoming` fires is configured in Stripe Billing settings.
  If it turns out that no upcoming-invoice event fires before a trial's first
  charge, the trial-conversion reminder should move to
  `customer.subscription.trial_will_end`; that is a one-case addition to
  `billingNoticeForEvent`, not a redesign.
- **A dunning setting worth checking, and a pre-existing gap it exposes.**
  Stripe's "subscription status after all retries fail" decides whether an
  unrecoverable invoice deletes the subscription. Only the _cancel_ setting
  produces an event this app acts on; under _mark unpaid_ or _leave past_due_
  the household keeps its paid caps indefinitely, because entitlement on `main`
  reads `planId` and never `subscriptionStatus`. That is not introduced here
  and is not fixed here — PR #364's `getEntitledPlan` is the fix — but writing
  the payment-failure copy is what surfaced it, so it is recorded rather than
  left in one person's head.
- **Not built here:** the plan-cap warning (it is not webhook-shaped, and it
  belongs with the plan re-cut), an unsubscribe path for the digest and recap
  (they are the genuinely non-transactional mail and need one), and HTML
  bodies (the shared template layer owns that).
