# Funnel analytics

We instrument lifecycle events with a tiny first-party shim
(`frontend/src/services/analytics.ts`). Authenticated events always post to
`/telemetry/product`, where actor and household identity come from the verified
JWT and structured events land in CloudWatch. Email confirmation is the one
pre-auth exception: the trusted auth handler writes `signup_completed` directly
after Cognito accepts the code, without logging the email. PostHog and GTM are
optional fan-out rails:

| Var                 | Required | Default                    | Notes                                                                |
| ------------------- | -------- | -------------------------- | -------------------------------------------------------------------- |
| `VITE_POSTHOG_KEY`  | No       | unset                      | Enables the optional PostHog fan-out; first-party events still flow. |
| `VITE_POSTHOG_HOST` | No       | `https://us.i.posthog.com` | Switch to `eu.i.posthog.com` for EU residency, or a self-hosted URL. |

We do **not** install `posthog-js`. The optional rail posts directly to PostHog's `/capture/` endpoint via `fetch`, saving ~50KB of bundle weight. The first-party rail likewise uses `fetch` and has no vendor account dependency. Trade-off: no autocapture, session replay, or hosted funnel UI until PostHog is configured.

## Event vocabulary

The full set is the `EventName` union in `analytics.ts`. Each is a deliberate funnel step or product interaction; we do not capture page views or DOM clicks.

| Event                      | Trigger                                       | Notes                                                                                                                                                 |
| -------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signup_completed`         | Email confirmation succeeded                  | First-party source is the trusted auth handler because confirmation does not return a JWT; no email is included.                                      |
| `household_created`        | `POST /households` returned 201               | `ordinal: 'first' \| 'subsequent'` distinguishes onboarding vs. multi-household creation.                                                             |
| `household_joined`         | `POST /households/join/:invite` returned 200  | Pairs with `invite_accepted`.                                                                                                                         |
| `invite_sent`              | Admin generated an invite link                | Health metric: how many households actually try to add a co-member.                                                                                   |
| `invite_accepted`          | A user joined via an invite link              | The conversion from `invite_sent`. Pair them in PostHog.                                                                                              |
| `plant_added`              | Plant successfully created                    | `ordinal: 'first' \| 'subsequent'` is the activation signal.                                                                                          |
| `plant_lifecycle_changed`  | Plant archived, restored, died, or given away | `context` carries the resulting status so retention and recovery behavior can be compared without recording plant details.                            |
| `plants_imported`          | Bulk plant import completed                   | `context` is a bounded row count, never plant content.                                                                                                |
| `plants_moved`             | Quick or bulk placement change completed      | `context` is a bounded plant count, never a space or plant name.                                                                                      |
| `task_created`             | Task POST returned 200                        | `taskType` for breakdowns.                                                                                                                            |
| `task_completed`           | Task complete POST returned 200               | The retention-defining event.                                                                                                                         |
| `task_snoozed`             | Snooze POST returned 200                      | High snooze rate is a signal that schedules are too aggressive.                                                                                       |
| `photo_uploaded`           | Image-confirm POST returned 200               | Engagement deepener.                                                                                                                                  |
| `subscription_upgraded`    | Stripe checkout started                       | Client-side **intent**, currently dormant while the commercial hold removes checkout controls. Its confirmed counterpart is `subscription_activated`. |
| `subscription_canceled`    | User opened the Stripe portal                 | Intent leading indicator, currently dormant while the commercial hold removes billing-management controls.                                            |
| `data_exported`            | CSV download started                          | Engaged-power-user signal.                                                                                                                            |
| `plant_identified`         | AI identification suggestion accepted         | Validates the Plant.id integration's value.                                                                                                           |
| `leaf_health_checked`      | Leaf-health assessment submitted              | Measures use of the image assessment flow without recording the image or result text.                                                                 |
| `plant_shared`             | Cutting-share link created                    | Intent from the household sharing a cutting.                                                                                                          |
| `plant_share_accepted`     | Shared cutting copied into a household        | Confirmed collaboration loop completion.                                                                                                              |
| `cutting_graft_started`    | Shared-cutting recipient starts acceptance    | Intent step immediately before the authenticated copy mutation.                                                                                       |
| `household_switched`       | Switcher activated a different household      | Multi-household engagement.                                                                                                                           |
| `shared_care_pulse_action` | Shared-care setup action or dismissal         | `context` is a fixed milestone key or `dismiss`.                                                                                                      |
| `climate_location_set`     | Household location saved                      | Validates the OpenWeatherMap integration's reach.                                                                                                     |
| `experiment_viewed`        | Landing experiment variant rendered           | Carries only the fixed experiment id and A/B variant.                                                                                                 |

## Server-confirmed events

Most events above fire from the browser shim and record _intent_;
`signup_completed` is written by the auth handler. Revenue also has to be
**confirmed** from the trusted backend — a client `subscription_upgraded` only
means the user reached Stripe checkout, not that money moved. The Stripe
webhook therefore emits a confirmed counterpart through a separate server shim
(`backend/src/utils/serverAnalytics.ts`, the `ServerEventName` union). It always
writes the typed first-party event to CloudWatch; optional PostHog fan-out is
gated on `POSTHOG_KEY`, a server/project key rather than the `VITE_` browser key.

| Event                    | Trigger                                                                                                                                                                           | Notes                                                                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subscription_activated` | Stripe webhook (`checkout.session.completed`, `checkout.session.async_payment_succeeded`, or `customer.subscription.created`) confirms a household is on an **active paid** plan. | The confirmed counterpart to `subscription_upgraded`. Properties: `plan: 'garden' \| 'greenhouse'`, `interval: 'month' \| 'year' \| 'lifetime'`. Fires once per activation. |

Where the server event differs from the browser ones:

- **Distinct id** is `household:<householdId>` (the webhook has no user session), carried with the same `$groups: { household }` key — so it lines up with the per-household funnels above.
- **Fires once.** Only the one-time activation events (`checkout.session.completed`, `customer.subscription.created`) emit it. `customer.subscription.updated` — which also fires on every renewal, plan change, and metadata edit — is deliberately excluded, so renewals don't inflate the conversion count. (A checkout that opens in a trial arrives as `subscription.created` with status `trialing` and is skipped until it flips to `active`.)
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
5. **True conversion**: `subscription_upgraded` → `subscription_activated` (intent → confirmed), aggregated by the `household` group. The drop-off is checkout abandonment; the confirmed step is the only revenue-true number.

## Optional hosted funnel UI

CloudWatch Logs Insights answers the baseline event-count questions without another vendor. If richer cohort/funnel exploration becomes necessary, configure PostHog and use its funnel UI instead of building an in-app admin surface with cross-user access.

## Adding a new event

1. Add the name to the `EventName` union in `analytics.ts`.
2. If the event needs a property, add it to `EventProps` (keep the type narrow).
3. Call `track('your_event', { ... })` from the call site (preferably in the service layer so every UI path picks it up).
4. Document the new event in this file.

If a proposed event is merely a click track without a decision it will inform, push back — we want a small set of meaningful funnel steps, not autocapture-via-typo.
