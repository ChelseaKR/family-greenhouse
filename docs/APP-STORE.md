# App Store Connect listing

Status: draft, unsubmitted. This is the content to paste into App Store
Connect at submission time, so writing marketing copy is not something that
happens under time pressure. Nothing here is new copy — the name, subtitle,
promotional text, description, and keywords are reproduced from
`store-assets/metadata/en-US.json`, which `store-assets/README.md` already
describes as "reviewed English metadata" and which
`scripts/validate-store-release.mjs` (`npm run mobile:validate`) checks for
size, character limits, and version parity in CI's `Lint` job. This document
adds the fields that JSON doesn't carry — price, the privacy questionnaire
answers, a shot list for the screenshots, and a reviewer-honesty section —
and states the current, re-verified truth behind every claim.

Everything below was checked against `origin/main` @ `06706f55`
(`chore(release): prepare 0.34.0 (#792)`) on 2026-09-14/15, including the
same-day analytics and universal-links work. Where a fact could go stale
quickly (deep links, push), the section says how to re-check it.

## 1. Listing fields

| Field                | Value                                                                                                                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App name             | Family Greenhouse: Plant Care (29/30 chars)                                                                                                                                                                                                                                           |
| Subtitle             | Shared watering for households (30/30 chars)                                                                                                                                                                                                                                          |
| Promotional text     | Everyone in the house sees one plant list. Claim a task so nobody waters twice, and hand the plants to a sitter with a link that expires. (137/170 chars)                                                                                                                             |
| Keywords             | `houseplant,tracker,schedule,reminder,roommate,housemate,chores,indoor,garden,sitter,journal` (91/100 chars)                                                                                                                                                                          |
| Primary category     | Lifestyle                                                                                                                                                                                                                                                                             |
| Age rating           | 4+ — no objectionable-content categories apply: no user-generated content visible outside an invited household, no open chat between strangers (the AI feature is a one-way assistant, not messaging), no gambling, no mature themes. Answer Apple's questionnaire "None" throughout. |
| Price (app download) | Free                                                                                                                                                                                                                                                                                  |
| In-app purchase      | None. The app sells nothing and collects no payment — see "Price and payment model" below.                                                                                                                                                                                            |

### Description

> Family Greenhouse is a plant care app built for a household, not for one person.
>
> Most plant trackers assume a single owner with a private list. If you live with a partner, family, or roommates, that is how a monstera gets watered twice on Saturday while the ferns get missed entirely, because everyone assumed someone else had done it. Family Greenhouse gives the whole house one plant list, one schedule, and one care history.
>
> SHARED BY DEFAULT
> • Everyone in the household sees the same plants, rooms, and care schedules.
> • A task nobody has picked up shows as up for grabs. Claim it and the rest of the house can see it is handled.
> • Marking care done records who did it and when, in a history everyone shares.
> • Invite people to the household with a link. Look after plants in more than one place? Belonging to several households is part of the Greenhouse plan.
>
> GOING AWAY? HAND THE PLANTS OVER
> • Create a plant sitter link that works without an account and expires on a date you choose — up to a week on the free plan, up to 90 days on a paid one.
> • Your sitter sees what needs water and which room it is in, and nothing else about your household.
> • Revoke the link the moment you are home.
>
> EVERY PLANT, TRACKED
> • Plant profiles with room, photos, and your own notes.
> • Watering, feeding, repotting, and custom tasks on the schedules you set.
> • A photo timeline so you can look back at how a plant has changed.
> • Identify a plant from a photo (one identification a month on the free plan, more on paid plans), and run a leaf health check when something looks off.
> • Subscribe to upcoming care from your own calendar app.
>
> EMAIL REMINDERS
> • Email reminders when care is due, plus an optional weekly digest of the plants most at risk.
> • Set quiet hours so reminders do not arrive overnight.
> • This version sends reminders by email. Push notifications are not part of this release.
>
> ASK ABOUT YOUR PLANTS
> • A plant care assistant, included with the paid Garden and Greenhouse plans, answers questions using your household's own plants and tasks. Plans are bought on the web, not in the app.
> • Any reminder it suggests is shown for your confirmation before anything is scheduled.
> • Report an answer that looks wrong and we review it.
>
> ACCOUNTS AND PRICING
> Family Greenhouse is free to download. This app does not sell subscriptions and collects no payment. It shows your current plan and usage as read-only information.
>
> Privacy policy: https://familygreenhouse.net/legal/privacy
> Support: https://familygreenhouse.net/support
> Delete your account: https://familygreenhouse.net/account-deletion

Both the description and the promotional text lead with the household
angle deliberately — see `store-assets/README.md`, "What each field is
doing": Planta, Greg, Blossom, and PictureThis are all single-user
trackers, so shared care is the one claim in this listing that isn't also
true of an app with a six-figure review count.

### Price and payment model

The app itself is free to download; there is no paid tier of the app and no
in-app purchase. The listing must say this because it's the reason
Guideline 3.1.1 doesn't apply here in the way it might look like it should:
subscriptions exist, but only on the web, never through the app.

Actual current subscription pricing (`backend/src/models/plans.ts`, the
source of truth — verify there before a submission if pricing may have
changed since this was written):

| Plan       | Monthly | Annual                                 | Lifetime                                   |
| ---------- | ------- | -------------------------------------- | ------------------------------------------ |
| Seedling   | Free    | —                                      | —                                          |
| Garden     | $4.99   | ~~$39.99/yr~~ withdrawn from new sales | ~~$149 one-time~~ withdrawn from new sales |
| Greenhouse | $9.99   | ~~$79.99/yr~~ withdrawn from new sales | —                                          |

Annual and lifetime cadences on Garden, and annual on Greenhouse, were
withdrawn from new sales 2026-09-02 (ADR 0012 — the per-household AI-cost
ceiling exceeds what those cadences earn per month). Existing subscribers on
them keep renewing; only monthly is currently offered to a new household.
None of this is sold in the app: `BillingSettings.tsx` gates on
`isNativeApp()` and shows a neutral "Plan changes aren't available in the
app," with no link, and the native `/pricing` route is informational only.
This is Apple's Guideline 3.1.1 rule for a "digital goods" subscription, not
a choice made for this listing — see `docs/mobile.md`, "Store payment
rules," for the two-store policy this follows and the one surface that
still slips a price into the app (§4 below covers it).

## 2. Privacy nutrition label (App Privacy questionnaire)

Answer this section from `frontend/ios/App/App/PrivacyInfo.xcprivacy` —
it's the source of truth, was updated today alongside the analytics launch
(`ba7b3096`, PR #791, "product analytics, cookieless by construction"), and
is broader than the 7-type/all-App-Functionality summary still written in
`docs/mobile-release-checklist.md`, which predates that PR and is now stale
on this specific point. The manifest currently declares 10 data types:

| Data type                  | Linked to identity | Used to track you | Purpose                      |
| -------------------------- | ------------------ | ----------------- | ---------------------------- |
| Name                       | Yes                | No                | App Functionality            |
| Email Address              | Yes                | No                | App Functionality            |
| Phone Number (optional)    | Yes                | No                | App Functionality            |
| Photos or Videos           | Yes                | No                | App Functionality            |
| Other User Content         | Yes                | No                | App Functionality            |
| User ID                    | Yes                | No                | App Functionality, Analytics |
| Device ID (optional)       | Yes                | No                | App Functionality            |
| Product Interaction        | Yes                | No                | Analytics                    |
| Performance Data           | No                 | No                | Analytics                    |
| Coarse Location (optional) | Yes                | No                | App Functionality            |

**"Data Used to Track You": No.** `NSPrivacyTracking` is `false` and
`NSPrivacyTrackingDomains` is empty in the manifest. There is no
cross-app/cross-site tracking, no data broker, and no advertising use of
any collected type.

What each row actually is, for whoever fills out the questionnaire:

- **Name / Email / Phone Number** — account and membership data
  (`legal.json`, "Account info"). Phone number is opt-in, only collected if
  SMS reminders are turned on, and stays on file even if SMS is later
  switched off (production SMS is currently off regardless — see §4).
- **Photos or Videos** — plant photos a user uploads, stored in S3: through
  the native camera or photo picker on a plant's page and Add plant, and
  the WebView file picker elsewhere. Every photo is downscaled and its EXIF,
  XMP and other metadata, GPS included, is removed on the device before
  upload (`docs/mobile.md`, "Photos"), so photos add nothing to the
  location rows. The camera and the photo library are opened only when the
  user taps to add a photo.
- **Other User Content** — plant names, notes, task text, and similar
  free-text fields a household enters.
- **Device ID (optional)** — the APNs push token, collected only when the
  person turns notifications on in the app (native push ships switched off;
  see `docs/native-push-setup.md`). Used only to deliver this app's own
  reminders: not advertising, not analytics, not tracking. It is deleted when
  they turn notifications off on that phone, sign out on it, leave the
  household it was set up under, or delete the account. It is declared in
  `PrivacyInfo.xcprivacy` now so the manifest never lags a build that turns
  push on; answer the App Privacy question the same way. On Google Play the
  counterpart is **Device or other IDs**: collected, not shared, App
  functionality, optional.
- **Coarse Location (optional)** — only if a household sets one. This is a
  city name plus the coordinates a geocoder returns for it, not device GPS
  — the app never requests precise location. It's used to fetch local
  weather for climate-aware care tips (`legal.json`, "Optional household
  location").
- **User ID, Product Interaction, Performance Data (Analytics)** — the
  first-party product analytics shipped today in PR #791. It is
  cookieless by construction (no cookie, `localStorage`, or
  `sessionStorage` — see `frontend/src/services/analytics.ts`'s header
  comment), keyed only to the Cognito `sub` and an opaque household UUID
  set after sign-in, with `$geoip_disable` on every event so no location
  is derived from IP. It fans out to PostHog (US region, one-year
  retention) only when a project key is configured; the first-party
  `/telemetry/product` and `/telemetry/frontend` endpoints always receive
  it. A household can opt out from Settings → Preferences, and Global
  Privacy Control / Do Not Track silence it automatically — all before any
  event is sent, none queued or stored.
- **Google Analytics 4 (website only — not in the app).** Since 2026-09-17
  familygreenhouse.net loads GA4 in browsers. It never loads inside the
  Capacitor shell (`isNativeApp()` in `frontend/src/services/googleAnalytics.ts`),
  and `scripts/validate-store-release.mjs` refuses a store build that carries
  the measurement ID, so none of the answers above change because of it.
- **Sentry (not currently active)** — the code supports an optional Sentry
  DSN for crash/error monitoring, which would add Crash Data and
  Performance Data with stack traces. No DSN is configured on the hosted
  service today, so nothing is sent to Sentry. Re-check this before
  submission if that has changed — it would need a Privacy manifest update
  and a questionnaire answer to match.

## 3. Screenshots

`store-assets/app-store/` already holds real, rendered PNGs — this is not
an empty folder structure. Confirmed present:

- `app-icon-1024.png`
- `ipad-13/01-dashboard.png` … `04-tasks.png` (4 frames)
- `iphone-6.9/01-dashboard.png` … `04-tasks.png` (4 frames)

All eight were captured by `npm run store:screenshots --workspace
frontend` against the seeded **store-demo household** — "The Fernwood
House" (`backend/src/local-server-store-demo.ts`, started with
`SEED_STORE_DEMO=1`), not a live user's data. What's actually in each
frame:

| #   | Frame        | Real content                                                                                                                                                                                                                                       |
| --- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01  | Dashboard    | The Fernwood House dashboard, greeting member Dana Whitfield, showing household-wide task status: one overdue job nobody has claimed ("up for grabs") and four due today, across all three members (Dana Whitfield, Marisol Reyes, Theo Nakamura). |
| 02  | Plants       | The shared plant list: 8 plants (Monstera, Fiddle Leaf Fig, Golden Pothos, Aloe, Snake Plant, Peace Lily, ZZ Plant, Jade Plant) across 5 rooms (Living Room, Kitchen, Bedroom, Back Study, Back Porch).                                            |
| 03  | Plant detail | A single plant's detail page — room, schedule, and care history. Renders the brand placeholder image, not a photo (see gap below).                                                                                                                 |
| 04  | Tasks        | The household task list, including the claim/up-for-grabs interaction on the unclaimed overdue job.                                                                                                                                                |

Google Play's `store-assets/google-play/phone/` has the same four frames
plus `app-icon-512.png` and `feature-graphic-1024x500.png`.

Known gaps in this set, carried over from `store-assets/README.md` and
still true — worth fixing before they're needed, not hidden:

- **No plant photographs in any frame.** Every plant in the store-demo
  household has no `imageUrl`, so the plant-detail hero and card images all
  render the brand placeholder rather than a photo. Fixing this needs real,
  consented photographs of real plants added to the seed — not a synthetic
  or stock image standing in for "this household's plant."
- **No caption overlays.** These are raw device frames; both stores support
  captioned marketing frames and most competitors use them.
- **No Android tablet screenshots**, despite the iPad frames proving the
  app runs on a tablet — Play down-ranks large-screen surfacing without
  7"/10" frames.
- **Four frames each.** Apple allows up to 10, Play up to 8 — there's room
  to add more before submission (a household-invite or sitter-link screen
  would show a real differentiator the current four don't touch).
- **English-only**, despite the app itself shipping a complete, gate-enforced
  Spanish catalog (`frontend/src/i18n/locales/es`). Both stores localize the
  listing independently of the binary; this needs a native-Spanish reviewer,
  not a machine translation, since the listing is the whole first
  impression.

## 4. Known gaps — be honest with the reviewer if asked

Issue [#469](https://github.com/ChelseaKR/family-greenhouse/issues/469) is
the record of an older `docs/mobile.md` telling an Apple reviewer to look at
"camera photo capture + the offline app shell" as differentiating native
features when neither was real — the issue calls the resulting rejection
risk "a multi-week loop... the expensive way to find out." Current state of
each item it raised, re-verified today:

1. **Camera / offline overclaim — fixed.** `docs/mobile.md` no longer makes
   either claim; it states plainly that "there is currently no native
   capability to point a reviewer at" and explains why: every photo path is
   a plain `<input type="file">` (not `@capacitor/camera`), and the shells
   work offline because the built bundle is inside the binary, not because
   of any runtime caching or sync. If a reviewer asks what's native about
   this app, the honest answer is: nothing yet, except a push-notification
   plugin that's deliberately unreachable (see #3 below). Do not say
   otherwise in review notes.

   **Update, 2026-09-18:** the camera half is no longer true for builds made
   after the native-camera change. On a plant's page and on Add plant, the
   shells now show Take photo and Choose photo, backed by
   `@capacitor/camera` (the system camera and the system photo picker). Name
   it in review notes only for a build that carries it, after trying both
   buttons on a device running that build. The leaf-health, sitter and
   caretaker photo screens are still the WebView file input. See
   `docs/mobile.md`, "Photos".

2. **Deep links / universal links — not working yet, don't claim they are.**
   Tonight's work (PRs #731, #736, #762, #768) landed the iOS side of
   _serving_ the association file: `apple-app-site-association` is live at
   `https://familygreenhouse.net/.well-known/apple-app-site-association`
   (verified `200 application/json` today) and carries the real Apple Team
   ID (`6X5YH93QNM`, with the similarly-shaped Enrollment ID now refused by
   value). But as of the last check, Apple's own CDN
   (`app-site-association.cdn-apple.com`) was still serving a stale cached
   404 for it — a propagation wait, not a defect, per `docs/mobile.md`'s
   own re-check log. Re-run
   `curl -sSI https://app-site-association.cdn-apple.com/a/v1/familygreenhouse.net`
   before submission; don't trust a memory of it being fixed.
   Even once that clears, the **app-side** half is not built: no
   `@capacitor/app` package, no `appUrlOpen` handler, and no Associated
   Domains entitlement in `App.entitlements`. That's deliberate ordering
   (`docs/mobile.md`: "the association file has to be live and verifiable
   at the domain first"), but it means every link the backend currently
   emails — household invites, sitter links, the task-due reminder link,
   unsubscribe, the calendar feed — still opens the browser today, not the
   app, and asks a user who has the app installed to sign in again. Android
   now has its generated `autoVerify` intent-filter, but no
   `assetlinks.json` until the two Play signing-certificate fingerprints are
   committed (`docs/mobile.md`, "Android App Links").

3. **Push notifications — not functional, deliberately hidden from the UI.**
   `@capacitor/push-notifications` is the only Capacitor plugin linked in
   either native project (confirmed against `frontend/package.json` today:
   `@capacitor/core`, `@capacitor/android`, `@capacitor/ios`,
   `@capacitor/push-notifications` — no `@capacitor/camera`, no
   `@capacitor/app`). `registerNativePush()` has zero call sites anywhere in
   `frontend/src` (confirmed by `git grep`) — it's reachable only from its
   own unit test, not from any screen a user can reach. The iOS entitlement
   (`App.entitlements`, `aps-environment`) is committed and CI-gated, which
   only means a _future_ registration attempt won't be rejected for a
   missing entitlement — it does not mean push works today. The backend FCM
   sender (`services/fcmNotifier.ts`) is written but reads a Secrets
   Manager credential that is blank in every environment, so it makes no
   network calls. This release's reminders are email-only, and the listing
   says so in two places (subtitle-adjacent bullet and the "EMAIL
   REMINDERS" section above) — don't let a reviewer find a push toggle that
   does nothing, because there isn't one to find.

   **Update, 2026-09-18:** native push is now built (APNs directly for iOS,
   FCM for Android, an opt-in on the Tasks page and a Settings row), but it
   is behind two switches that are both off: `VITE_NATIVE_PUSH_ENABLED` in
   the store build and `native_push_enabled` in Terraform. With either off,
   a build shows no push UI at all, so everything above still holds for any
   build made without them. Claim push in review notes only for a build made
   after `docs/native-push-setup.md` is done, and after step 8 there
   (a reminder received on a device running that build).

4. **One more, not from #469: a locked feature can show a price with no way
   to pay.** `LockedFeature` (gating `/chat`, the trip-sitter offer, and API
   key settings) checks the household's plan, not `isNativeApp()`. On a free
   Seedling household inside the native shell, it will show "Included with
   Garden — $4.99 a month for the whole household" and, for an admin, a
   **Change plan** button — a subscription price and a call to action inside
   an app that cannot sell one. The button's destination is native-gated and
   says plan changes aren't available, so it never reaches a purchase
   mechanism, but a reviewer who reads "a plant care assistant answers
   questions about your plants" in the description, taps Chat, and lands on
   a priced upgrade prompt is a real Guideline 2.3.1 (accurate metadata) /
   3.1.1 (in-app purchase) risk on the same screen. `docs/mobile.md`, "Store
   payment rules," documents this as not yet fixed. If a reviewer flags it,
   the honest answer is: known, tracked, not yet gated on native — fixing it
   is a product decision about what paying members see in the app, not a
   quick patch.

## Sources checked while writing this

- `store-assets/metadata/en-US.json` — the reviewed listing copy this
  document reproduces.
- `store-assets/README.md`, `store-assets/app-store/`,
  `store-assets/google-play/` — asset inventory and rationale.
- `backend/src/models/plans.ts` — plan pricing and withdrawn cadences.
- `frontend/ios/App/App/PrivacyInfo.xcprivacy`,
  `frontend/src/services/analytics.ts`,
  `frontend/src/i18n/locales/en/legal.json` — privacy answers.
- `docs/mobile.md`, `docs/mobile-release-checklist.md` — native capability
  table, deep-link status, push status, store payment rules.
- Issue [#469](https://github.com/ChelseaKR/family-greenhouse/issues/469)
  and its full comment history — the overclaim history and every
  subsequent re-verification.
- `frontend/package.json` — installed Capacitor plugins.
- `backend/src/local-server-store-demo.ts` — store-demo household contents.
- Live checks: `curl` against `familygreenhouse.net/.well-known/…`,
  `/legal/privacy`, `/support`, `/account-deletion`, and
  `app-site-association.cdn-apple.com`.
