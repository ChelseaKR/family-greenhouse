# Product analytics

**Decision, 2026-09-13:** product analytics are on. The portfolio's former rule
("no analytics, tracking, beacons, pixels or cookies anywhere") is revoked for
this repository, and replaced by the narrower posture below: PostHog only,
cookieless, opt-out-honouring, keyed to a pseudonymous account id after
sign-in, with test fixtures excluded structurally.

Why: the funnel has been measured exactly once, by hand, from CloudFront logs
with smoke fixtures excluded by eye — 12 real sessions, 3 sign-ups, 1
confirmed, 1 activated, 0 payments over 13 days. That ritual does not scale to
a second reading, and the product cannot be steered on one. This document is
the design; `frontend/src/services/analytics.ts` and
`backend/src/utils/serverAnalytics.ts` are the implementation; the privacy
page (`legal.privacy.collect.*` / `legal.privacy.thirdParties.posthog`) and
`docs/audits/dpia.md` are the disclosure. Keep all four in step.

## The funnel

Seven stages, one event each. This table is a contract:
`scripts/check-doc-figures.mjs` holds every row to a live call site (the named
file must contain the event literal in code, comments excluded), so a refactor
that drops a stage fails `npm run verify` instead of showing up as a permanent
zero on a dashboard step.

| #   | Stage              | Event                    | Emitted by                                            | Rail and notes                                                                                                                                                                             |
| --- | ------------------ | ------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Sign-up started    | `signup_started`         | `frontend/src/features/auth/RegisterPage.tsx`         | Browser, after `POST /auth/signup` returned 201. No identity yet — held in memory, replayed at first sign-in.                                                                              |
| 2   | Email confirmed    | `signup_completed`       | `frontend/src/features/auth/ConfirmEmailPage.tsx`     | Browser, after `POST /auth/confirm` succeeded; held and replayed like #1. The auth handler also logs it server-side, without identity, so CloudWatch has it even if sign-in never comes.   |
| 3   | Activated          | `plant_added`            | `frontend/src/features/onboarding/FirstPlantStep.tsx` | Browser, `ordinal: 'first'`. The full plant form (`features/plants/AddPlantPage.tsx`) emits the same event with the computed ordinal, so a first plant added there counts too.             |
| 4   | Hit a limit        | `plan_limit_hit`         | `frontend/src/services/api.ts`                        | Browser, from the axios response interceptor on every **402** — plant cap, member cap, homes cap, API keys, chat, cross-home Today, the identify allowance. `context` is the route family. |
| 5   | Opened billing     | `billing_opened`         | `frontend/src/features/settings/SettingsPage.tsx`     | Browser, when the resolved settings tab is `billing` (tab click, deep link or post-checkout redirect alike). The one page-level event we record.                                           |
| 6   | Checkout started   | `subscription_upgraded`  | `frontend/src/services/billingService.ts`             | Browser, after the Stripe checkout session was created. Intent, not money.                                                                                                                 |
| 7   | Checkout completed | `subscription_activated` | `backend/src/services/billing.ts`                     | Server, from the Stripe webhook. For a recurring plan this is a **trial start**; `subscription_paid` (below) is the money.                                                                 |

Two funnels, because identity changes shape at stage 3:

- **Person funnel, stages 1 → 5:** aggregate by user. Stages 1–2 carry no
  household yet (a brand-new person has none), so they only pair at the
  person level, and they reach PostHog on the same tab's first sign-in.
- **Household funnel, stages 3 → 7:** aggregate by the `household` group. Every
  event from `household_created` on carries `$groups.household`, including the
  server-side stage 7, whose `distinct_id` is `household:<id>` rather than a
  person. Aggregating by group is what lines the browser stages up with the
  webhook stage; a person-aggregated funnel would show stage 7 as unreachable.

## What is on, and what is not

| Question                 | Answer                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Vendor                   | PostHog Cloud **US** (`us.i.posthog.com`), acting as a processor. Optional `PRODUCTION_POSTHOG_HOST` can point at `eu.i.posthog.com`; the CloudFront CSP admits both, the privacy page would need its region sentence changed.                                                                                           |
| Transport                | A `fetch` POST to `/capture/` from `analytics.ts`. **No `posthog-js`**, no vendor script on the page (`script-src 'self'` in both CSPs), no cookie set or read, no localStorage/sessionStorage written by the shim. This is what posthog-js calls `persistence: 'memory'`, without the 50 KB.                            |
| Identity                 | `distinct_id` = the Cognito `sub`, set by `identify()` **after sign-in only**. Never email or name. Before sign-in nothing is sent at all (events are held in memory; see below). `$groups.household` = the household UUID.                                                                                              |
| Properties               | Closed vocabulary only — plan id, `first`/`subsequent`, task type, count buckets, a bounded route family. The API accept-list (`backend/src/models/telemetry.ts`) has the same shape and rejects anything else, so a property the server refuses never reaches PostHog either. Never form contents, never free text.     |
| Page views / clicks      | Not captured. The single page-level event is `billing_opened`, which is a funnel stage. No autocapture, no heatmaps, no surveys.                                                                                                                                                                                         |
| Session recording        | Never. `docs/audits/dpia.md` line "No session replay" stays true by construction: there is no SDK in the page that could record one.                                                                                                                                                                                     |
| IP address / location    | The request's IP reaches PostHog at transport. Every payload carries `$geoip_disable: true` so no city/region is derived, and the project's **IP data capture configuration** is set to _discard_ (owner step below) so the address is not stored on the event.                                                          |
| Retention                | PostHog keeps events for the plan's retention period — one year on the tier we start on. First-party copies are CloudWatch `product_event` log lines under the API log group's retention. **Account deletion does not delete the PostHog person**; a support request does, by hand in the PostHog UI (DPIA open item 7). |
| Opt-out                  | Three controls, any one of which silences every rail in `analytics.ts` (PostHog **and** the first-party endpoint): the in-app switch (Settings → Preferences → Product analytics, per device), Global Privacy Control, Do Not Track. See "Opt-out signals".                                                              |
| Consent banner           | None required for this rail: no cookie, no device identifier, no cross-site storage, no vendor script. The cookieless property is a characterization test (`analytics.test.ts`, "cookieless by construction"), not a setting.                                                                                            |
| Google Tag Manager / GA4 | **Removed 2026-09-13.** A dormant loader shipped unkeyed since the start; GTM/GA4 set cookies (and, on iOS, would have made this "tracking" in Apple's sense — ATT prompt, tracking domains). PostHog only. Nothing from Google remains in either CSP.                                                                   |
| Sentry                   | **Separate decision; stays off.** See "Sentry" at the end.                                                                                                                                                                                                                                                               |

### Configuration

| Var                 | Required | Default                    | Notes                                                                                                                                                                                                                                                                        |
| ------------------- | -------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_POSTHOG_KEY`  | No       | unset                      | Browser rail. Unset, only the PostHog fan-out is skipped; first-party events still flow. In production it is the **repository-scope** secret `PRODUCTION_POSTHOG_KEY` — the `build` job has no `environment:`, so an environment-scoped secret would reach the bundle empty. |
| `VITE_POSTHOG_HOST` | No       | `https://us.i.posthog.com` | `us.i.posthog.com` or `eu.i.posthog.com`; a custom host also needs an explicit CSP change in `infrastructure/modules/frontend/main.tf`.                                                                                                                                      |
| `POSTHOG_KEY`       | No       | unset                      | Server rail (Lambda env, via `TF_VAR_posthog_key` from the same GitHub secret). Gates the Stripe-webhook fan-out, i.e. funnel stage 7.                                                                                                                                       |

## Event vocabulary

The full set is the `EventName` union in `analytics.ts`. Each is a deliberate funnel step or product interaction; we do not capture page views or DOM clicks.

| Event                      | Trigger                                       | Notes                                                                                                                                                                                                                                                   |
| -------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signup_started`           | `POST /auth/signup` returned 201              | Funnel stage 1. Fired by an anonymous visitor, so it is **held and replayed at sign-in** — see "Events fired before sign-in".                                                                                                                           |
| `signup_completed`         | Email confirmation succeeded                  | Funnel stage 2. Browser event held and replayed like `signup_started`; the auth handler also writes a first-party copy without identity, because confirmation returns no JWT.                                                                           |
| `household_created`        | `POST /households` returned 201               | `ordinal: 'first' \| 'subsequent'` distinguishes onboarding vs. multi-household creation.                                                                                                                                                               |
| `household_joined`         | `POST /households/join/:invite` returned 200  | Pairs with `invite_accepted`.                                                                                                                                                                                                                           |
| `invite_sent`              | Admin generated an invite link                | Health metric: how many households actually try to add a co-member.                                                                                                                                                                                     |
| `invite_accepted`          | A user joined via an invite link              | The conversion from `invite_sent`. Pair them in PostHog.                                                                                                                                                                                                |
| `plant_added`              | Plant successfully created                    | `ordinal: 'first' \| 'subsequent'` is the activation signal (funnel stage 3).                                                                                                                                                                           |
| `plant_lifecycle_changed`  | Plant archived, restored, died, or given away | `context` carries the resulting status so retention and recovery behavior can be compared without recording plant details.                                                                                                                              |
| `plants_imported`          | Bulk plant import completed                   | `context` is a bounded row count, never plant content.                                                                                                                                                                                                  |
| `plants_moved`             | Quick or bulk placement change completed      | `context` is a bounded plant count, never a space or plant name.                                                                                                                                                                                        |
| `task_created`             | Task POST returned 200                        | `taskType` for breakdowns.                                                                                                                                                                                                                              |
| `task_completed`           | Task complete POST returned 200               | The retention-defining event.                                                                                                                                                                                                                           |
| `task_snoozed`             | Snooze POST returned 200                      | High snooze rate is a signal that schedules are too aggressive.                                                                                                                                                                                         |
| `photo_uploaded`           | Image-confirm POST returned 200               | Engagement deepener.                                                                                                                                                                                                                                    |
| `plan_limit_hit`           | The API answered **402**                      | Funnel stage 4, recorded once from the axios interceptor for every gated surface. `context` is the route family (`plants`, `households_members`, `plants_identify`, `me_today`, `api-keys`…), never a route with an id; retries within 10 s count once. |
| `billing_opened`           | Settings → Billing rendered                   | Funnel stage 5. The one page-level event; keyed on the resolved tab so deep links and post-checkout redirects count.                                                                                                                                    |
| `subscription_upgraded`    | Stripe checkout session created               | Funnel stage 6, client-side **intent**, fired from `billingService.createCheckout` after the session exists. Its confirmed counterpart is `subscription_activated`.                                                                                     |
| `subscription_canceled`    | _Not wired — no call site_                    | **Declared but never fired,** deliberately. The name overstates its specified trigger: opening the billing portal is not a cancellation. Real churn is server-confirmed as `subscription_deactivated` below, so this one stays unwired.                 |
| `data_exported`            | CSV download started                          | Engaged-power-user signal.                                                                                                                                                                                                                              |
| `plant_identified`         | AI identification suggestion accepted         | Validates the Plant.id integration's value.                                                                                                                                                                                                             |
| `leaf_health_checked`      | Leaf-health assessment submitted              | Measures use of the image assessment flow without recording the image or result text.                                                                                                                                                                   |
| `plant_shared`             | Cutting-share link created                    | Intent from the household sharing a cutting.                                                                                                                                                                                                            |
| `plant_share_accepted`     | Shared cutting copied into a household        | Confirmed collaboration loop completion.                                                                                                                                                                                                                |
| `cutting_graft_started`    | Shared-cutting recipient starts acceptance    | Intent step immediately before the authenticated copy mutation. Fired anonymously; held and replayed at sign-in.                                                                                                                                        |
| `household_switched`       | Switcher activated a different household      | Multi-household engagement.                                                                                                                                                                                                                             |
| `shared_care_pulse_action` | Shared-care setup action or dismissal         | `context` is a fixed milestone key or `dismiss`.                                                                                                                                                                                                        |
| `climate_location_set`     | Household location saved                      | Validates the OpenWeatherMap integration's reach.                                                                                                                                                                                                       |
| `experiment_viewed`        | Landing experiment variant rendered           | Carries only the fixed experiment id and A/B variant. Fired by an anonymous visitor, so it is **held and replayed at sign-in** — see "Events fired before sign-in".                                                                                     |
| `upgrade_requested`        | Member asked the admins to upgrade            | Fired by `upgradeRequestService` once the request POST returns; `upgradeTo` is the target plan id the server resolved, never free text.                                                                                                                 |

## Server-confirmed events

Most events above fire from the browser shim and record _intent_;
`signup_completed` is also written by the auth handler. Revenue has to be
**confirmed** from the trusted backend — a client `subscription_upgraded` only
means the user reached Stripe checkout, not that money moved. The Stripe
webhook therefore emits a confirmed counterpart through a separate server shim
(`backend/src/utils/serverAnalytics.ts`, the `ServerEventName` union). It always
writes the typed first-party event to CloudWatch; PostHog fan-out is gated on
`POSTHOG_KEY`, the Lambda-side copy of the same project key.

Three events, one per real subscription transition. **Only the middle one is money.**

| Event                      | Trigger                                                                                                                | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `subscription_activated`   | `checkout.session.completed` or `checkout.session.async_payment_succeeded` — checkout finished on a paid plan.         | **Not revenue for recurring plans — for a household's FIRST subscription this is a trial start.** The trial is once per household (`trialConsumedAt`), so a household that resubscribes gets no trial days and is charged at checkout; this event cannot be read as "no money yet" for it either. Properties: `plan`, `interval: 'month' \| 'year' \| 'lifetime'`. `interval: 'lifetime'` is the exception: a one-time `mode: 'payment'` purchase with no trial, counted only once Stripe says `paid`. |
| `subscription_paid`        | `customer.subscription.updated` where `previous_attributes.status` shows the subscription was not `active` and now is. | **The paid conversion.** Stripe only moves a subscription to `active` after an invoice is actually paid. Properties: `plan`, `interval`, `from: 'trialing' \| 'past_due' \| 'unpaid' \| 'incomplete' \| 'paused' \| 'other'`.                                                                                                                                                                                                                                                                          |
| `subscription_deactivated` | `customer.subscription.deleted` — the subscription is gone at Stripe.                                                  | **Churn.** Properties: `plan` (the tier _lost_, read before the row is rewritten), `interval`, and `churnReason: 'requested' \| 'payment_failed' \| 'payment_disputed' \| 'other'` when Stripe recorded one.                                                                                                                                                                                                                                                                                           |

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

- **Distinct id** is `household:<householdId>` (the webhook has no user session), carried with the same `$groups: { household }` key — so it lines up with the per-household funnel above when the funnel is aggregated by the group.
- **Renewals and plan changes are silent.** They arrive as `customer.subscription.updated` with `status` absent from `previous_attributes` — the status did not change — so nothing is emitted and the conversion count is not inflated.
- **Idempotent, in the safe direction.** Stripe webhooks are at-least-once. Every emit is gated on the `STRIPE_EVENT#<id>` dedupe ledger, so a redelivery re-applies the subscription fields but never counts revenue twice. The ledger is written _after_ the apply, so a crash in the narrow window between the ledger write and the emit loses the event instead of duplicating it: these numbers can **undercount, never double-count**. That is the correct direction for a revenue figure, but it means they are a funnel signal, not an accounting ledger — Stripe remains the source of truth for what was billed.
- **Best-effort.** The first-party log is synchronous and local. PostHog fan-out never throws and the webhook `void`s its promise, so a vendor outage can never 5xx the webhook (which would make Stripe retry an already-applied delivery).
- **No opt-out signal applies.** A webhook has no browser. The event is operational telemetry about a subscription, keyed to the household, and it is what makes stage 7 countable at all.

## Opt-out signals

`analyticsOptedOut()` in `analytics.ts` is consulted before anything is sent
**or queued**. It is true when any of these holds:

| Control                                                   | Where it comes from                                                                                                                                            | What it silences                                                                                                                                                                      |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In-app switch, Settings → Preferences → Product analytics | `setAnalyticsOptOut()` writes one localStorage key (`fg-analytics-opt-out`), the only thing the shim ever writes to the device. Per device.                    | Every rail in `analytics.ts`: PostHog and `POST /telemetry/product`. Not the operational rail (`frontendTelemetry.ts`), which identifies no one. Also drops anything held for replay. |
| Global Privacy Control (`navigator.globalPrivacyControl`) | Browser setting (Firefox, Brave, DuckDuckGo, extensions). The CCPA/CPRA regulations name it as a valid opt-out-of-sale/sharing request, so we treat it as one. | Same as the switch.                                                                                                                                                                   |
| Do Not Track (`navigator.doNotTrack === '1'`)             | Browser setting. No legal weight, but honoured since the first release.                                                                                        | Same as the switch, **plus** the operational rail (`telemetryAllowed()` in `frontendTelemetry.ts`) and Sentry, were it ever keyed.                                                    |

The two signals are browser features. **WKWebView never sends `DNT: 1` and
WebKit has no Global Privacy Control**, so inside the iOS shell neither can
ever fire; the in-app switch is the only opt-out there, and the privacy page
says so. All three are read at call time, never cached, so a control that
appears mid-session takes effect on the next event.

## Excluding test fixtures and health checks

Any funnel that counted the post-deploy smoke would be fiction: 11 of the 13
households created since 2026-09-01 were smoke fixtures, and ~380k of 450k
CloudFront requests in that window were the Route 53 health check. Both are
excluded by construction, not by filtering after the fact:

- **The smoke browser declares Global Privacy Control before the app boots.**
  `frontend/tests/e2e/post-deploy-smoke.spec.ts` adds
  `declareGlobalPrivacyControl` (from `post-deploy-smoke-support.ts`) as an
  init script on every page, and the shim treats the signal as an opt-out. The
  browser cannot know it is a fixture — the `isTestFixture` claim lives in
  DynamoDB — so the harness tells it, in the one vocabulary the app already
  honours. The unit test in `postDeploySmokeSupport.test.ts` runs the same
  function against jsdom and then asks `analyticsOptedOut()`, so the harness
  and the shim are pinned to each other from both sides.
- **The smoke asserts that nothing left.** A file-level `page.on('request')`
  collector records any request to a `posthog.com` host or to
  `POST /telemetry/product`; each test ends with `expectNoAnalyticsLeaks()`.
  A deployed bundle that ignored the signal would fail the smoke and be rolled
  back — the privacy page's promise, enforced against production on every
  release rather than assumed.
- **The health check executes no JavaScript.** Route 53 fetches the HTML and
  matches a string; no script runs, no event can be emitted. It pollutes
  CloudFront logs, not PostHog.
- **The Stripe-webhook rail is not exercised by the smoke** (no checkout), so
  stage 7 has no fixture path. Should a smoke ever run a test-mode checkout,
  the household stamp `isTestFixture` on the household row is the field to
  gate `serverAnalytics.capture` on.

## Privacy & data

- **Identity** for first-party events is derived from the verified JWT on the server, never accepted in the body. The PostHog rail uses the Cognito `sub` (UUID). Neither rail sends email, name, plant names, or household-identifying free text.
- **Household group key** is the household UUID (see "Household group analytics" below). It is an opaque pseudonymous identifier rather than a direct name or address, but we still treat it as personal data: access-controlled, retention-bounded, and never exposed in a public payload.
- **Event properties** are restricted server-side to enums and bucketed counts. Unknown fields and free-form values are rejected before logging.
- **Opt-out** is honoured on all three controls above; under any of them every method in `analytics.ts` short-circuits.
- **Nothing is stored on the device** by the shim except the opt-out preference itself, and only when asked.
- We use `fetch` with `keepalive: true` so events don't drop on navigation but also don't block the request that triggered them.

## Household group analytics

Product events are keyed by `distinct_id` = the user's Cognito sub. That's correct for per-user funnels, but it makes the collaborative core of the product — "does a household get a 2nd _active_ member?" — **unmeasurable**: `invite_sent` (fired by the admin) and `invite_accepted` (fired by the invitee) are different users, so nothing pairs them, and "active members per household" can't be counted across distinct ids.

We fix this with PostHog [group analytics](https://posthog.com/docs/product-analytics/group-analytics). Every captured event carries a `$groups: { household: <uuid> }` key:

- `setActiveHousehold(id)` in `analytics.ts` sets the ambient household group. The `authStore` wires it: on login/session restore (the effective household = active id `??` the user's claim household), and whenever the switcher changes the active household. `reset()` (logout) clears it.
- The first time a household is seen in a session, the shim sends a `$groupidentify` (`group_type: 'household'`, `group_key`: the id) so the group exists in the PostHog UI. It does **not** send any group properties (no names/addresses) — only the opaque key.
- When no household is active, the `$groups` key is omitted entirely (no stray `{ household: null }`).

What this unlocks in PostHog:

- **Collaboration activation** — `invite_sent` → `invite_accepted` paired _at the household level_, and "households with ≥2 active members". This is the product's core differentiator and was previously impossible to chart.
- **Per-household retention** — retention and stickiness computed over households, not just users, so a household where one member churns but another stays active reads as retained.
- **Per-household cohorts** — slice any funnel by household size, plan, or members.

Privacy: the group key is an opaque household UUID, analogous to the Cognito sub used as `distinct_id`. It is not a direct identifier, but it is linkable pseudonymous personal data and is handled under the same controls described above.

## Funnels worth building in PostHog

1. **Sign-up funnel** (aggregate by person): `signup_started` → `signup_completed` → `household_created (first)` → `plant_added (first)` → `plan_limit_hit` → `billing_opened`. The drop-off between any two steps is the highest-leverage UX problem. Stages 1–2 arrive at first sign-in, so they are visible only for people who eventually signed in; CloudWatch has the server-side `signup_completed` for everyone else.
2. **Activation-to-paid funnel** (aggregate by the `household` group): `household_created` → `plant_added (first)` → `plan_limit_hit` → `billing_opened` → `subscription_upgraded` → `subscription_activated` → `subscription_paid (from = trialing)`. Step 5→6 is checkout abandonment; 6→7 is the trial conversion rate, the first step where money exists.
3. **Collaboration funnel**: `household_created` → `invite_sent` → `invite_accepted`, aggregated by the `household` group so the admin's `invite_sent` and the invitee's `invite_accepted` pair across users. Below 50% of households reaching `invite_sent` means the collaborative pitch isn't landing.
4. **Climate adoption**: `household_created` → `climate_location_set`. If <10%, the dashboard nudge needs work.
5. **Where the wall is**: `plan_limit_hit` broken down by `context`. Which cap people actually hit is the pricing question.
6. **Churn**: `subscription_deactivated` split by `churnReason`. A high `payment_failed` share is a dunning/retry problem; a high `requested` share is a product-value problem.

## What this instrumentation cannot answer

Every rail in `analytics.ts` is identity-gated: the first-party
`/telemetry/product` endpoint requires a JWT, and the PostHog rail requires a
`distinct_id`. An anonymous visitor therefore produces **no network traffic at
all**. That is the privacy posture working as designed — no beaconing from
marketing pages — but it means the acquisition half of the funnel is dark.

### Events fired before sign-in

Four events fire for signed-out visitors: `signup_started` (the register
form), `signup_completed` (the confirmation code), `experiment_viewed` (the
landing hero A/B test) and `cutting_graft_started` (the graft CTA on a public
cutting card). Because every rail is identity-gated they would evaporate, so
they are **held in memory and replayed once the same browser tab signs in**.
Nothing is sent while the visitor is anonymous, so the privacy posture is
unchanged (the characterization tests in `analytics.test.ts` still assert zero
network traffic before `identify()`). The queue is bounded, and `reset()`
(logout) drops it so one visitor's impression is never attributed to the next.

The limit is the tab. Register → confirm → sign in is one tab by design, so
the two sign-up stages normally survive; a visitor who confirms from the
reminder email (#737) in a fresh tab loses `signup_started` (the server's
`POST /auth/signup` log still has it), and one who never signs in loses both
from PostHog. Persisting the queue across tabs would mean storing analytics
state on the device, which is the line this design does not cross.

What this does and does not buy, stated plainly:

- **Numerator: yes.** "Of the people who signed up, how many saw variant B?" is
  now answerable, and the assignment also rides every later authenticated event
  as a super-property.
- **Denominator: no.** "How many people saw variant B?" is still unanswerable.
  Impressions by visitors who never sign in are not recorded, by design.

Observable today (authenticated, or trusted server-side):

| Funnel step                                  | Observable? | Where                                                                 |
| -------------------------------------------- | ----------- | --------------------------------------------------------------------- |
| Landing page view                            | No          | no event exists                                                       |
| Care guide / blog view                       | No          | no event exists                                                       |
| Pricing page view                            | No          | no event exists                                                       |
| Signup started (register form accepted)      | Yes         | `signup_started`, replayed at sign-in                                 |
| Signup completed                             | Yes         | auth handler, `POST /auth/confirm`; browser event replayed at sign-in |
| Household created / first plant / first task | Yes         | browser shim, service layer                                           |
| A plan limit hit                             | Yes         | `plan_limit_hit`, axios interceptor                                   |
| Billing opened                               | Yes         | `billing_opened`, settings page                                       |
| Checkout reached (intent)                    | Yes         | `billingService.createCheckout`                                       |
| Trial started                                | Yes         | Stripe webhook → `subscription_activated`                             |
| **Trial converted to paid**                  | **Yes**     | Stripe webhook → `subscription_paid` where `from = 'trialing'`        |
| **Churn / cancellation**                     | **Yes**     | Stripe webhook → `subscription_deactivated`, split by `churnReason`   |
| A/B variant seen, by a visitor who signed up | Yes         | `experiment_viewed`, replayed at sign-in                              |
| A/B variant seen, by anyone                  | No          | anonymous impressions are not recorded                                |

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
4. **The key is an owner step.** Nothing in this repository can create the
   PostHog project or the secret. Until `PRODUCTION_POSTHOG_KEY` exists, both
   rails are inert in production and CloudWatch Logs Insights is the only place
   any of this can be read. See "Turning PostHog on".
5. **Pre-identity events are tab-bound.** See "Events fired before sign-in".
6. **Account deletion does not delete the PostHog person.** `DELETE /me` erases
   the account and household data; the PostHog person keyed to the same sub
   stays until the plan's retention period ends or a support request removes it
   by hand. The privacy page says so. Automating it needs a PostHog personal
   API key in the API Lambda, which is a separate decision (DPIA open item 7).
7. **Top-of-funnel measurement requires a privacy decision.** Making landing,
   pricing, and care-guide reach measurable means recording something for
   visitors who have not signed in. The privacy page states we do not record
   general page views; any change here must update that page in the same
   commit.
8. **The retention figure is stated, not enforced.** PostHog's plan-level
   retention is what the privacy page quotes ("currently one year"); a plan
   change moves it and nothing here would notice. Confirm it in the project
   settings when the key is created and whenever the plan changes.

## Turning PostHog on (owner steps)

Everything below the secret is already wired: the `build` job passes the
secret to Vite, the `terraform` job passes it to the API Lambda, the shim
initialises on the key, the seven funnel stages fire, fixtures are excluded,
and the privacy page describes the result. Nothing in this repository can do
the three steps that remain, and no agent session should hold the value.

1. Create a PostHog project on the **US cloud** (`docs/external-services-setup.md`,
   "PostHog"): Settings → Project → General → **IP data capture configuration →
   discard**; leave replay, autocapture, heatmaps and surveys off; note the
   plan's retention period against the privacy page's "currently one year".
2. In Terminal.app, as a **repository** secret (not an environment secret —
   the `build` job has no `environment:` and would receive it empty):

   ```bash
   gh secret set PRODUCTION_POSTHOG_KEY --repo ChelseaKR/family-greenhouse
   ```

3. Deploy (tag a release). Then verify: sign in from a normal browser and see
   the `$identify` in PostHog → Activity; watch the release's post-deploy smoke
   pass with no PostHog request (it asserts this); build funnels 1 and 2 above.

To turn it off: delete the secret and redeploy. First-party events keep
flowing to CloudWatch either way.

## Sentry

Separate decision, **not made here; Sentry stays off.** The plumbing exists
(`frontend/src/sentry.ts`, lazy `@sentry/react` on `VITE_SENTRY_DSN`, DNT-gated,
replay pinned to 0, PII scrubbed; `backend/src/utils/sentry.ts` around every
route) and both CSPs already admit `*.sentry.io`. Enabling it would require, in
one change: two Sentry projects and the `PRODUCTION_FRONTEND_SENTRY_DSN` /
`PRODUCTION_BACKEND_SENTRY_DSN` secrets (repository scope, same reason as the
PostHog key); the privacy page's Sentry paragraph rewritten from "switched off
today" to what a crash report carries (stack traces and browsing breadcrumbs);
the DPIA's processor table; and the iOS privacy manifest gaining
`NSPrivacyCollectedDataTypeCrashData` (not linked, not tracking, purpose
AppFunctionality). It would also need an opt-out that works in the iOS shell,
where DNT never fires — the in-app switch above governs product analytics only.

## Adding a new event

1. Add the name to the `EventName` union in `analytics.ts`, to
   `productEventNames` in `backend/src/models/telemetry.ts`, and to the
   `ProductTelemetryEvent` enum in `docs/api-spec.yaml`.
2. If the event needs a property, add it to `EventProps` and the Zod schema
   (keep the type narrow; never free text).
3. Call `track('your_event', { ... })` from the call site (preferably in the
   service layer so every UI path picks it up).
4. Document the new event in the vocabulary table above. If it is a funnel
   stage, add its row to "The funnel" and bump `FUNNEL_STAGES_EXPECTED` in
   `scripts/check-doc-figures.mjs` in the same change — the gate holds the
   row to the call site from then on.

If a proposed event is merely a click track without a decision it will inform, push back — we want a small set of meaningful funnel steps, not autocapture-via-typo.
