# Funnel analytics

We instrument lifecycle events with a tiny PostHog-compatible shim
(`frontend/src/services/analytics.ts`). Activation:

| Var                 | Required | Default                    | Notes                                                                |
| ------------------- | -------- | -------------------------- | -------------------------------------------------------------------- |
| `VITE_POSTHOG_KEY`  | No       | unset                      | When unset, every `track()` is a no-op.                              |
| `VITE_POSTHOG_HOST` | No       | `https://us.i.posthog.com` | Switch to `eu.i.posthog.com` for EU residency, or a self-hosted URL. |

We do **not** install `posthog-js`. The shim posts directly to PostHog's `/capture/` endpoint via `fetch`, saving ~50KB of bundle weight. Trade-off: no autocapture, no session replay, no feature flags. We can add the SDK later when one of those becomes worth the bundle cost.

## Event vocabulary

The full set is the `EventName` union in `analytics.ts`. Each is a deliberate funnel step or product interaction; we do not capture page views or DOM clicks.

| Event                   | Trigger                                      | Notes                                                                                     |
| ----------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `signup_completed`      | Email confirmation succeeded                 | Fires once per user, immediately after the JWT lands.                                     |
| `household_created`     | `POST /households` returned 201              | `ordinal: 'first' \| 'subsequent'` distinguishes onboarding vs. multi-household creation. |
| `household_joined`      | `POST /households/join/:invite` returned 200 | Pairs with `invite_accepted`.                                                             |
| `invite_sent`           | Admin generated an invite link               | Health metric: how many households actually try to add a co-member.                       |
| `invite_accepted`       | A user joined via an invite link             | The conversion from `invite_sent`. Pair them in PostHog.                                  |
| `plant_added`           | Plant successfully created                   | `ordinal: 'first' \| 'subsequent'` is the activation signal.                              |
| `task_created`          | Task POST returned 200                       | `taskType` for breakdowns.                                                                |
| `task_completed`        | Task complete POST returned 200              | The retention-defining event.                                                             |
| `task_snoozed`          | Snooze POST returned 200                     | High snooze rate is a signal that schedules are too aggressive.                           |
| `photo_uploaded`        | Image-confirm POST returned 200              | Engagement deepener.                                                                      |
| `subscription_upgraded` | Stripe checkout started                      | Intent, not confirmation. The webhook is source of truth for revenue.                     |
| `subscription_canceled` | User opened the Stripe portal                | Intent leading indicator only.                                                            |
| `data_exported`         | CSV download started                         | Engaged-power-user signal.                                                                |
| `plant_identified`      | AI identification suggestion accepted        | Validates the Plant.id integration's value.                                               |
| `household_switched`    | Switcher activated a different household     | Multi-household engagement.                                                               |
| `climate_location_set`  | Household location saved                     | Validates the OpenWeatherMap integration's reach.                                         |

## Privacy & data

- **Distinct id** is the Cognito `sub` (UUID). We do not send email, name, plant names, or any household-identifying free text.
- **Event properties** are restricted to enums and bucketed counts. The TypeScript type makes it impossible to slip a free-form string in.
- **Do Not Track** is honored — when `navigator.doNotTrack === '1'` every method short-circuits.
- We use `fetch` with `keepalive: true` so events don't drop on navigation but also don't block the request that triggered them.

## Funnels worth building in PostHog

Once events flow, build these funnels in the PostHog UI:

1. **Activation funnel**: `signup_completed` → `household_created (first)` → `plant_added (first)` → `task_completed (first)`. The drop-off between any two steps is your highest-leverage UX problem.
2. **Collaboration funnel**: `household_created` → `invite_sent` → `invite_accepted`. Below 50% of households reaching `invite_sent` means the collaborative pitch isn't landing.
3. **Climate adoption**: `household_created` → `climate_location_set`. If <10%, the dashboard nudge needs work.
4. **Upgrade intent**: `subscription_upgraded` from each tier. Pair with cohorts (>10 plants, >2 members) to test the pricing-tier hypotheses in `docs/strategy-review.md`.

## Why no admin dashboard

PostHog already has an excellent funnel UI. Rebuilding it inside the app would mean another React surface to maintain plus a backend that's allowed to scan all users — exactly the kind of vector we don't want. Spend that engineering elsewhere; click through to PostHog when you need a chart.

## Adding a new event

1. Add the name to the `EventName` union in `analytics.ts`.
2. If the event needs a property, add it to `EventProps` (keep the type narrow).
3. Call `track('your_event', { ... })` from the call site (preferably in the service layer so every UI path picks it up).
4. Document the new event in this file.

If you find yourself adding a 16th event that's just a click track, push back — we want a small set of meaningful funnel steps, not autocapture-via-typo.
