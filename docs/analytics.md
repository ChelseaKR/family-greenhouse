# Funnel analytics

We instrument lifecycle events with a tiny first-party shim
(`frontend/src/services/analytics.ts`). Authenticated events always post to
`/telemetry/product`, where actor and household identity come from the verified
JWT and structured events land in CloudWatch. Email confirmation is the one
pre-auth exception: the trusted auth handler writes `signup_completed` directly
after Cognito accepts the code, without logging the email. PostHog and GTM are
optional fan-out rails:

| Var                 | Required | Default                    | Notes                                                                                    |
| ------------------- | -------- | -------------------------- | ---------------------------------------------------------------------------------------- |
| `VITE_POSTHOG_KEY`  | No       | unset                      | Enables the optional PostHog fan-out; first-party events still flow.                     |
| `VITE_POSTHOG_HOST` | No       | `https://us.i.posthog.com` | `us.i.posthog.com` or `eu.i.posthog.com`; custom hosts also need an explicit CSP change. |

Production/staging deploys read the project key from the
`PRODUCTION_POSTHOG_KEY` / `STAGING_POSTHOG_KEY` GitHub Actions secrets and the
cloud host from the corresponding `*_POSTHOG_HOST` repository variable. The
same values reach the browser build and backend fan-out, and CloudFront's CSP
permits both documented PostHog cloud regions.

We do **not** install `posthog-js`. The optional rail posts directly to PostHog's `/capture/` endpoint via `fetch`, saving ~50KB of bundle weight. The first-party rail likewise uses `fetch` and has no vendor account dependency. Trade-off: no autocapture, session replay, or hosted funnel UI until PostHog is configured.

## Event vocabulary

The full set is the `EventName` union in `analytics.ts`. Each is a deliberate funnel step or product interaction; we do not capture page views or DOM clicks.

| Event                      | Trigger                                       | Notes                                                                                                                                                                                                                                       |
| -------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signup_completed`         | Email confirmation succeeded                  | First-party source is the trusted auth handler because confirmation does not return a JWT; no email is included.                                                                                                                            |
| `household_created`        | `POST /households` returned 201               | `ordinal: 'first' \| 'subsequent'` distinguishes onboarding vs. multi-household creation.                                                                                                                                                   |
| `household_joined`         | `POST /households/join/:invite` returned 200  | Pairs with `invite_accepted`.                                                                                                                                                                                                               |
| `invite_sent`              | Admin generated an invite link                | Health metric: how many households actually try to add a co-member.                                                                                                                                                                         |
| `invite_accepted`          | A user joined via an invite link              | The conversion from `invite_sent`. Pair them in PostHog.                                                                                                                                                                                    |
| `plant_added`              | Plant successfully created                    | `ordinal: 'first' \| 'subsequent'` is the activation signal.                                                                                                                                                                                |
| `plant_lifecycle_changed`  | Plant archived, restored, died, or given away | `context` carries the resulting status so retention and recovery behavior can be compared without recording plant details.                                                                                                                  |
| `plants_imported`          | Bulk plant import completed                   | `context` is a bounded row count, never plant content.                                                                                                                                                                                      |
| `plants_moved`             | Quick or bulk placement change completed      | `context` is a bounded plant count, never a space or plant name.                                                                                                                                                                            |
| `task_created`             | Task POST returned 200                        | `taskType` for breakdowns.                                                                                                                                                                                                                  |
| `task_completed`           | Task complete POST returned 200               | The retention-defining event.                                                                                                                                                                                                               |
| `task_snoozed`             | Snooze POST returned 200                      | High snooze rate is a signal that schedules are too aggressive.                                                                                                                                                                             |
| `photo_uploaded`           | Image-confirm POST returned 200               | Engagement deepener.                                                                                                                                                                                                                        |
| `subscription_upgraded`    | Stripe checkout session created               | Client-side **intent**, fired from `billingService.createCheckout` after the session exists. Its confirmed counterpart is `subscription_activated`.                                                                                         |
| `subscription_canceled`    | _Not wired — no call site_                    | **Declared but never fired,** deliberately. The name overstates its specified trigger: opening the billing portal is not a cancellation. Real churn is now server-confirmed as `subscription_deactivated` below, so this one stays unwired. |
| `data_exported`            | CSV download started                          | Engaged-power-user signal.                                                                                                                                                                                                                  |
| `plant_identified`         | AI identification suggestion accepted         | Validates the Plant.id integration's value.                                                                                                                                                                                                 |
| `leaf_health_checked`      | Leaf-health assessment submitted              | Measures use of the image assessment flow without recording the image or result text.                                                                                                                                                       |
| `plant_shared`             | Cutting-share link created                    | Intent from the household sharing a cutting.                                                                                                                                                                                                |
| `plant_share_accepted`     | Shared cutting copied into a household        | Confirmed collaboration loop completion.                                                                                                                                                                                                    |
| `cutting_graft_started`    | Shared-cutting recipient starts acceptance    | Intent step immediately before the authenticated copy mutation.                                                                                                                                                                             |
| `household_switched`       | Switcher activated a different household      | Multi-household engagement.                                                                                                                                                                                                                 |
| `shared_care_pulse_action` | Shared-care setup action or dismissal         | `context` is a fixed milestone key or `dismiss`.                                                                                                                                                                                            |
| `climate_location_set`     | Household location saved                      | Validates the OpenWeatherMap integration's reach.                                                                                                                                                                                           |
| `experiment_viewed`        | Landing experiment variant rendered           | Carries only the fixed experiment id and A/B variant. Fired by an anonymous visitor, so it is **held and replayed at sign-in** — see "Events fired before sign-in".                                                                         |

## Server-confirmed events

Most events above fire from the browser shim and record _intent_;
`signup_completed` is written by the auth handler. Revenue also has to be
**confirmed** from the trusted backend — a client `subscription_upgraded` only
means the user reached Stripe checkout, not that money moved. The Stripe
webhook therefore emits a confirmed counterpart through a separate server shim
(`backend/src/utils/serverAnalytics.ts`, the `ServerEventName` union). It always
writes the typed first-party event to CloudWatch; optional PostHog fan-out is
gated on `POSTHOG_KEY`, a server/project key rather than the `VITE_` browser key.

Three events, one per real subscription transition. **Only the middle one is money.**

| Event                      | Trigger                                                                                                                | Notes                                                                                                                                                                                                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subscription_activated`   | `checkout.session.completed` or `checkout.session.async_payment_succeeded` — checkout finished on a paid plan.         | **Not revenue for recurring plans — this is a trial start.** Properties: `plan`, `interval: 'month' \| 'year' \| 'lifetime'`. `interval: 'lifetime'` is the exception: a one-time `mode: 'payment'` purchase with no trial, counted only once Stripe says `paid`. |
| `subscription_paid`        | `customer.subscription.updated` where `previous_attributes.status` shows the subscription was not `active` and now is. | **The paid conversion.** Stripe only moves a subscription to `active` after an invoice is actually paid. Properties: `plan`, `interval`, `from: 'trialing' \| 'past_due' \| 'unpaid' \| 'incomplete' \| 'paused' \| 'other'`.                                     |
| `subscription_deactivated` | `customer.subscription.deleted` — the subscription is gone at Stripe.                                                  | **Churn.** Properties: `plan` (the tier _lost_, read before the row is rewritten), `interval`, and `churnReason: 'requested' \| 'payment_failed' \| 'payment_disputed' \| 'other'` when Stripe recorded one.                                                      |

How to count each question:

- **Trials started** → `subscription_activated` where `interval != 'lifetime'`.
- **Trials converted to paid** → `subscription_paid` where `from = 'trialing'`.
- **Recovered payments** (a failed charge later succeeded) → `subscription_paid` where `from != 'trialing'`. Real revenue, but **not** a new conversion — do not add it to the line above.
- **Revenue at the moment it lands** → `subscription_paid` **plus** `subscription_activated` where `interval = 'lifetime'`.
- **Churn** → `subscription_deactivated`, split by `churnReason` (voluntary vs. dunning failure have completely different remedies).

Why `customer.subscription.updated` and not the first `invoice.payment_succeeded`:

- It is **already delivered** to our endpoint (see `docs/external-services-setup.md`); `invoice.payment_succeeded` is not, so an invoice-based handler would have shipped dark until someone edited the Stripe dashboard.
- Stripe only moves a subscription to `active` **after** an invoice is paid, so the transition is money-gated without inspecting an invoice.
- The Subscription object carries our `householdId` metadata; an Invoice does not, so the invoice route would need an extra Stripe lookup inside the webhook.
- Identifying the _first_ paid invoice needs durable per-household state (renewals emit the same event); a status transition is self-describing.

Where the server events differ from the browser ones:

- **Distinct id** is `household:<householdId>` (the webhook has no user session), carried with the same `$groups: { household }` key — so it lines up with the per-household funnels above.
- **Renewals and plan changes are silent.** They arrive as `customer.subscription.updated` with `status` absent from `previous_attributes` — the status did not change — so nothing is emitted and the conversion count is not inflated.
- **Idempotent, in the safe direction.** Stripe webhooks are at-least-once. Every emit is gated on the `STRIPE_EVENT#<id>` dedupe ledger, so a redelivery re-applies the subscription fields but never counts revenue twice. The ledger is written _after_ the apply, so a crash in the narrow window between the ledger write and the emit loses the event instead of duplicating it: these numbers can **undercount, never double-count**. That is the correct direction for a revenue figure, but it means they are a funnel signal, not an accounting ledger — Stripe remains the source of truth for what was billed.
- **Best-effort.** The first-party log is synchronous and local. PostHog fan-out never throws and the webhook `void`s its promise, so a vendor outage can never 5xx the webhook (which would make Stripe retry an already-applied delivery).

## Privacy & data

- **Identity** for first-party events is derived from the verified JWT on the server, never accepted in the body. The optional PostHog rail uses the Cognito `sub` (UUID). Neither rail sends email, name, plant names, or household-identifying free text.
- **Household group key** is the household UUID (see "Household group analytics" below). It is an opaque pseudonymous identifier rather than a direct name or address, but we still treat it as personal data: access-controlled, retention-bounded, and never exposed in a public payload.
- **Event properties** are restricted server-side to enums and bucketed counts. Unknown fields and free-form values are rejected before logging.
- **Do Not Track** is honored — when `navigator.doNotTrack === '1'` every method short-circuits.
- We use `fetch` with `keepalive: true` so events don't drop on navigation but also don't block the request that triggered them.

## Household group analytics

Product events are keyed by `distinct_id` = the user's Cognito sub. That's correct for per-user funnels, but it makes the collaborative core of the product — "does a household get a 2nd _active_ member?" — **unmeasurable**: `invite_sent` (fired by the admin) and `invite_accepted` (fired by the invitee) are different users, so nothing pairs them, and "active members per household" can't be counted across distinct ids.

We fix this with PostHog [group analytics](https://posthog.com/docs/product-analytics/group-analytics). Every captured event carries a `$groups: { household: <uuid> }` key, and the GTM dataLayer payloads carry a plain `household` field:

- `setActiveHousehold(id)` in `analytics.ts` sets the ambient household group. The `authStore` wires it: on login/session restore (the effective household = active id `??` the user's claim household), and whenever the switcher changes the active household. `reset()` (logout) clears it.
- The first time a household is seen in a session, the shim sends a `$groupidentify` (`group_type: 'household'`, `group_key`: the id) so the group exists in the PostHog UI. It does **not** send any group properties (no names/addresses) — only the opaque key.
- When no household is active, the `$groups` key is omitted entirely (no stray `{ household: null }`).

What this unlocks in PostHog:

- **Collaboration activation** — `invite_sent` → `invite_accepted` paired _at the household level_, and "households with ≥2 active members". This is the product's core differentiator and was previously impossible to chart.
- **Per-household retention** — retention and stickiness computed over households, not just users, so a household where one member churns but another stays active reads as retained.
- **Per-household cohorts** — slice any funnel by household size, plan, or members.

Privacy: the group key is an opaque household UUID, analogous to the Cognito sub used as `distinct_id`. It is not a direct identifier, but it is linkable pseudonymous personal data and is handled under the same controls described above.

## Funnels worth building in PostHog

CloudWatch can measure the full activation funnel beginning with the trusted,
pre-login `signup_completed` event. PostHog only receives identified browser
events, so its per-user activation funnel begins after sign-in:

1. **Activation funnel**: in CloudWatch, `signup_completed` → `household_created (first)` → `plant_added (first)` → `task_completed (first)`; in PostHog, begin at `household_created`. The drop-off between any two steps is your highest-leverage UX problem.
2. **Collaboration funnel**: `household_created` → `invite_sent` → `invite_accepted`, set to aggregate by the `household` group (see "Household group analytics") so the admin's `invite_sent` and the invitee's `invite_accepted` pair across users. Below 50% of households reaching `invite_sent` means the collaborative pitch isn't landing.
3. **Climate adoption**: `household_created` → `climate_location_set`. If <10%, the dashboard nudge needs work.
4. **Upgrade intent**: `subscription_upgraded` from each tier. Pair with cohorts (>10 plants, >2 members).
5. **Trial conversion**: `subscription_upgraded` → `subscription_activated` → `subscription_paid (from = trialing)`, aggregated by the `household` group. Step 1→2 is checkout abandonment; step 2→3 is the trial conversion rate, and it is the first step in this funnel where money exists.
6. **Churn**: `subscription_deactivated` split by `churnReason`. A high `payment_failed` share is a dunning/retry problem; a high `requested` share is a product-value problem.

## What this instrumentation cannot answer

Every rail in `analytics.ts` is identity-gated: the first-party
`/telemetry/product` endpoint requires a JWT, and the optional PostHog rail
requires a `distinct_id`. An anonymous visitor therefore produces **no network
traffic at all**. That is the privacy posture working as designed — no beaconing
from marketing pages — but it means the acquisition half of the funnel is dark.

### Events fired before sign-in

Two events fire for signed-out visitors: `experiment_viewed` (the landing hero
A/B test) and `cutting_graft_started` (the graft CTA on a public cutting card).
Because every rail is identity-gated, both used to evaporate — present in the
code, listed in the vocabulary, producing zero rows.

They are now **held in memory and replayed once the same browser signs in**.
Nothing is sent while the visitor is anonymous, so the privacy posture is
unchanged (the characterization tests in `analytics.test.ts` still assert zero
network traffic before `identify()`). The queue is bounded, and `reset()`
(logout) drops it so one visitor's impression is never attributed to the next.

What this does and does not buy, stated plainly:

- **Numerator: yes.** "Of the people who signed up, how many saw variant B?" is
  now answerable, and the assignment also rides every later authenticated event
  as a super-property.
- **Denominator: no.** "How many people saw variant B?" is still unanswerable.
  Impressions by visitors who never sign in are not recorded, by design.

So the A/B test yields a variant-attributed **conversion count**, not a
conversion **rate**. Reading it as a rate would divide by a number that does not
exist. Getting the denominator requires the top-of-funnel privacy decision in
"Known gaps" below.

Observable today (authenticated, or trusted server-side):

| Funnel step                                  | Observable? | Where                                                               |
| -------------------------------------------- | ----------- | ------------------------------------------------------------------- |
| Landing page view                            | No          | no event exists                                                     |
| Care guide / blog view                       | No          | no event exists                                                     |
| Pricing page view                            | No          | no event exists                                                     |
| Signup started (register form)               | No          | no event exists                                                     |
| Signup completed                             | Yes         | auth handler, `POST /auth/confirm`                                  |
| Household created / first plant / first task | Yes         | browser shim, service layer                                         |
| Checkout reached (intent)                    | Yes         | `billingService.createCheckout`                                     |
| Trial started                                | Yes         | Stripe webhook → `subscription_activated`                           |
| **Trial converted to paid**                  | **Yes**     | Stripe webhook → `subscription_paid` where `from = 'trialing'`      |
| **Churn / cancellation**                     | **Yes**     | Stripe webhook → `subscription_deactivated`, split by `churnReason` |
| A/B variant seen, by a visitor who signed up | Yes         | `experiment_viewed`, replayed at sign-in                            |
| A/B variant seen, by anyone                  | No          | anonymous impressions are not recorded                              |

So these questions currently have no answer:

- _"Did anyone who read a care guide sign up?"_ — **No.** Care guides emit
  nothing, and nothing links an anonymous read to a later account.
- _"Which entry page precedes a paid conversion?"_ — **No.** No entry page is
  recorded, and no attribution is carried through signup.
- _"What fraction of pricing-page visitors start a trial?"_ — **No.** The
  denominator does not exist.
- _"What fraction of landing visitors saw variant B?"_ — **No.** Same missing
  denominator; see "Events fired before sign-in".

And these now do:

- _"How many trials became paying customers?"_ — **Yes.** `subscription_paid`
  with `from = 'trialing'`. Exclude the other `from` values: those are recovered
  payments, not new conversions.
- _"How many paying households cancelled this month?"_ — **Yes.**
  `subscription_deactivated`, from a typed product event rather than a grep of
  the generic `subscription_updated` log line.
- _"Did variant B produce more signups than variant A?"_ — **Yes, as a count.**
  Not as a rate — the impression denominator does not exist.

## Known gaps

1. **Revenue events can undercount.** The dedupe ledger is written _after_ the
   subscription apply, and the emit happens after that, so a crash in between
   loses an event rather than duplicating it. Deliberate — for a revenue number
   an undercount is the safe failure — but it means `subscription_paid` is a
   funnel signal, not an accounting ledger. Stripe stays the source of truth for
   what was actually billed; reconcile against it before quoting a figure.
2. **`customer.subscription.updated` must stay subscribed at Stripe.** The paid
   conversion depends on it. It is on the documented endpoint event list, but it
   lives in the Stripe dashboard, not in this repo — nothing here fails if
   someone unticks it. The symptom would be `subscription_activated` continuing
   normally while `subscription_paid` silently goes to zero. If paid conversions
   flatline while trials keep starting, check the endpoint's event list first.
3. **A fully discounted first invoice would read as a paid conversion.** A
   100%-off coupon still moves the subscription to `active`, so it would count
   in `subscription_paid` for zero cents. We issue no coupons today; if that
   changes, the emit needs an amount check.
4. **No vendor is configured.** Neither `PRODUCTION_POSTHOG_KEY` nor
   `PRODUCTION_GTM_ID` is set, so PostHog and GTM are both inert in production
   and CloudWatch Logs Insights is the only place any of this can be read. The
   funnels listed above are queries someone has to write by hand.
5. **Top-of-funnel measurement requires a privacy decision.** Making landing,
   pricing, and care-guide reach measurable means recording something for
   visitors who have not signed in. The privacy page currently states we do not
   capture page views; any change here must update that page in the same
   commit.
6. **GTM is undisclosed.** `analytics.ts` will inject
   `googletagmanager.com/gtm.js` if `VITE_GTM_ID` is ever set, but the privacy
   page's third-party list does not mention Google. Setting that variable
   without amending the privacy page would make the page inaccurate.

## Optional hosted funnel UI

CloudWatch Logs Insights answers the baseline event-count questions without another vendor. If richer cohort/funnel exploration becomes necessary, configure PostHog and use its funnel UI instead of building an in-app admin surface with cross-user access.

## Adding a new event

1. Add the name to the `EventName` union in `analytics.ts`.
2. If the event needs a property, add it to `EventProps` (keep the type narrow).
3. Call `track('your_event', { ... })` from the call site (preferably in the service layer so every UI path picks it up).
4. Document the new event in this file.

If a proposed event is merely a click track without a decision it will inform, push back — we want a small set of meaningful funnel steps, not autocapture-via-typo.
