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

## 0. Readiness re-check, 2026-10-04

Re-verified against `origin/main` @ `c4a4f908` (after #911 to #919, the native
frame and the Plants redesign). This section supersedes anything older below
that it contradicts.

| Item                                     | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | How it was checked                                                                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Privacy manifest, collected data         | 11 types, tracking false, unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `npm run mobile:validate`                                                                                                                            |
| Privacy manifest, required-reason APIs   | **Was missing; now declared.** `@capacitor/camera` links IONCameraLib, which reads a file's creation date (`resourceValues(forKeys: [.creationDateKey])`). Its own manifest is not bundled into the app (its Package.swift lists no resource), so App Store Connect would reject the upload with ITMS-91053. FileTimestamp (C617.1, 3B52.1) is now in our manifest, and the validator requires it while the camera plugin is installed. Our own Swift and the other eight plugins call no required-reason API. | Source scan of every linked package, plus the manifests inside a built `App.app` (only Capacitor's and Cordova's are there, both empty of API types) |
| Usage strings                            | Camera and Photo Library present and specific. No microphone, location or photo-save strings, and none needed: the app never records audio, never asks for device location, and saves no photo (`saveToGallery: false`).                                                                                                                                                                                                                                                                                       | `Info.plist`, `services/nativeCamera.ts`                                                                                                             |
| Export compliance                        | `ITSAppUsesNonExemptEncryption` false (HTTPS only)                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `Info.plist`                                                                                                                                         |
| Device capabilities                      | **Was `armv7`** (a template leftover: the binary is arm64 only and the deployment target is iOS 15, where every device is arm64). Now `arm64`. Safe for a first submission.                                                                                                                                                                                                                                                                                                                                    | `Info.plist`, project build settings                                                                                                                 |
| Launch screen, icon                      | `LaunchScreen.storyboard`; one 1024×1024 universal icon with no alpha channel                                                                                                                                                                                                                                                                                                                                                                                                                                  | `sips -g hasAlpha`                                                                                                                                   |
| Appearance                               | Forced light (`UIUserInterfaceStyle` Light), as decided 2026-10-02                                                                                                                                                                                                                                                                                                                                                                                                                                             | `Info.plist`                                                                                                                                         |
| Universal links                          | **Working end to end now.** `applinks:familygreenhouse.net` entitlement, `@capacitor/app` with the `appUrlOpen` handler (`services/nativeDeepLinks.ts`), and Apple's CDN serves the association file (`200 application/json`, the right app ID)                                                                                                                                                                                                                                                                | `curl https://app-site-association.cdn-apple.com/a/v1/familygreenhouse.net`                                                                          |
| Push                                     | Built; `native_push_enabled` is on in production for iOS (2026-10-05, unverified on a device until setup step 8 passes); a store build shows push UI only when made with `VITE_NATIVE_PUSH_ENABLED=true` (4001 onward); Android off                                                                                                                                                                                                                                                                            | §4.3                                                                                                                                                 |
| Locked features show no price in the app | Fixed: `LockedFeature` drops the price and the plan button when `isNativeApp()` (#903)                                                                                                                                                                                                                                                                                                                                                                                                                         | `components/LockedFeature.tsx`                                                                                                                       |
| Legal and support URLs                   | `/legal/privacy`, `/support`, `/account-deletion` answer 200                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `curl`                                                                                                                                               |
| Store screenshots                        | Being re-captured by the store-screenshots lane for the new native frame; §3 describes the previous set                                                                                                                                                                                                                                                                                                                                                                                                        | not re-checked here                                                                                                                                  |

### Availability and the payment position (owner decision, 2026-10-04)

- **Availability: the United States storefront only.** In App Store
  Connect → Pricing and Availability, select the United States and nothing
  else. Every other storefront brings back the rule that the app and its
  metadata may not carry "buttons, external links, or other calls to
  action that direct customers to purchasing mechanisms other than in-app
  purchase" (Guideline 3.1.1(a)); the United States storefront is exempt
  from it. Widening availability later means re-reading this section first.
- **Ship as built.** The app stays a free download with no In-App Purchase.
  Garden and Greenhouse are sold only on familygreenhouse.net (Stripe), and a
  plan bought there applies in the app. The app shows the household's plan
  read-only, with no price, no purchase path, and no link or wording that
  points to one (see `docs/mobile.md`, "Store payment rules").
- **The position, if App Review asks:** Guideline 3.1.3(f), "Free
  Stand-alone Apps": "Free apps acting as a stand-alone companion to a paid
  web based tool ... do not need to use in-app purchase, provided there is
  no purchasing inside the app, or calls to action for purchase outside of
  the app." This is an argument, not a safe harbor. Its examples are
  business tools (VoIP, cloud storage, email, web hosting), and 3.1.1 says
  that unlocking "features or functionality within your app" needs In-App
  Purchase. 3.1.3(b) Multiplatform Services allows features bought on the
  web only "provided those items are also available as in-app purchases
  within the app," which this build does not do.
- **If App Review rejects under 3.1.1:** add In-App Purchase for the plans
  (StoreKit auto-renewing subscriptions alongside Stripe), which is what
  3.1.3(b) asks for. It is a larger project (a subscription group, App Store
  Server Notifications, merging Apple and Stripe entitlements per household,
  restore, Terms and privacy-label updates) and is not started until a
  rejection says it is needed.
- **The listing** no longer says where plans are bought: "Plans are bought on
  the web, not in the app." was removed from the description (owner
  decision, 2026-10-04).

Sources, read on 2026-10-04: Apple's App Review Guidelines
(<https://developer.apple.com/app-store/review/guidelines/>, "Last Updated:
June 8, 2026"), sections 3.1.1, 3.1.1(a), 3.1.3, 3.1.3(a), 3.1.3(b) and
3.1.3(f); and Apple's note on the United States change, "Updated guidelines
now available," May 1, 2025
(<https://developer.apple.com/news/?id=9txfddzf>).

### App Review notes (draft, paste at submission)

> Family Greenhouse is a shared plant-care app for a household. To review it, sign in with the demo account below, which belongs to a household with plants, rooms and three members.
>
> Demo account: [to be filled in App Store Connect only, never in this repository]
>
> What is native in the app: Apple's tab bar and navigation bar (Home, Plants, Tasks, Household, More), large titles, the back swipe, search and menus in the navigation bar on Plants, alerts and action sheets for confirmations, a native Settings list, the camera and photo picker (on a plant's page, "…" → Take photo / Choose photo, and on Add plant), the share sheet, printing a plant's passport, and haptics when care is marked done.
>
> The app sells nothing and collects no payment. Paid plans exist on our website; the app shows the household's plan as read-only and has no purchase path, price or link to one.
>
> Reminders in this version are sent by email. Push notifications are not enabled in this build.

Fill the demo account only in App Store Connect. Re-read the native list
against the build being submitted: name only what that build carries.

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
> • A plant care assistant, included with the paid Garden and Greenhouse plans, answers questions using your household's own plants and tasks.
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
in-app purchase. Subscriptions exist, but only on the web, never through the
app. Whether that satisfies Guideline 3.1.1 is a judgment, not a given: see
"Availability and the payment position" in §0 for the position taken and
the plan if App Review disagrees.

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
app," with no link, and in the app `/pricing` and `/gift` open Settings →
Plan status rather than any plans page.
This is Apple's Guideline 3.1.1 rule for a "digital goods" subscription, not
a choice made for this listing — see `docs/mobile.md`, "Store payment
rules," for the two-store policy this follows.

## 2. Privacy nutrition label (App Privacy questionnaire)

Answer this section from `frontend/ios/App/App/PrivacyInfo.xcprivacy` —
it's the source of truth. It gained the analytics types with PR #791
("product analytics, cookieless by construction"), Device ID with native
push (#851), and Crash Data for 0.37.1: the first-party error rail had been
sending error summaries from the shells without a manifest entry.
`scripts/validate-store-release.mjs` fails a store build whose manifest
drops any of these. The manifest currently declares 11 data types:

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
| Crash Data                 | No                 | No                | App Functionality            |
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
- **Crash Data (App Functionality, not linked)** — the first-party error
  rail (`frontend/src/services/frontendTelemetry.ts`) posts a report to our
  own `/telemetry/frontend` when the app hits an uncaught JavaScript error,
  an unhandled promise rejection, or a screen that fails to render. It runs
  inside the shells as well as on the website, so the app collects it. A
  report holds the error class (`TypeError` and so on, or "Network request
  failed"), the route with ids and tokens replaced by placeholders, a hash
  of those two, the build's commit id, and a random id made fresh for each
  app session; after an outage, also a count of reports that could not be
  delivered. No stack trace, no error message text, nothing typed into the
  app. It sends no account, household or device id and no auth header, and
  its session id is shared only with the (also unlinked) Performance Data
  reports, which is why it is **not linked**. API Gateway's access log keeps
  the connection's IP address for 30 days, as it does for every request;
  the report is never joined to it. The in-app analytics opt-out does not
  cover this rail. It was collected but undeclared through 0.37.0; the
  manifest declares it from 0.37.1, and the App Privacy answers in App
  Store Connect have to add it by hand.
- **Google Analytics 4 (website only — not in the app).** Since 2026-09-17
  familygreenhouse.net loads GA4 in browsers. It never loads inside the
  Capacitor shell (`isNativeApp()` in `frontend/src/services/googleAnalytics.ts`),
  and `scripts/validate-store-release.mjs` refuses a store build that carries
  the measurement ID, so none of the answers above change because of it.
- **Sentry (not currently active)** — the code supports an optional Sentry
  DSN for crash/error monitoring, which would send stack traces and
  breadcrumbs to a third party, well beyond the first-party Crash Data row
  above. No DSN is configured on the hosted service or in the store build
  template today, so nothing is sent to Sentry. Re-check this before
  submission if that has changed — the Crash Data and Performance Data
  rows, the manifest comment, and the privacy page would all need to say
  what Sentry receives.

## 3. Screenshots

`store-assets/app-store/` holds real, rendered PNGs:

- `app-icon-1024.png`
- `iphone-6.9/01-plants.png` … `08-notifications.png` (8 frames, 1320 x 2868):
  **the iOS app itself**, with the native tab bar and navigation bar
- `ipad-13/01-dashboard.png` … `04-tasks.png` (4 frames, 2064 x 2752): the
  website in Playwright, with the web layout and menu drawer

Both sets show the seeded **store-demo household**, "The Fernwood House"
(`backend/src/local-server-store-demo.ts`, started with `SEED_STORE_DEMO=1`):
invented people with `@example.com` addresses, not a live user's data. The
demo household is on the free Seedling plan, so no frame shows a price, a
plan to buy or an upgrade prompt.

### Regenerating the iPhone frames

Run `npm run store:screenshots:ios --workspace frontend` on a Mac with Xcode
and the iOS 26 simulator runtime, then look at every frame before
committing it. The script (`frontend/scripts/store-shots/capture-ios.mjs`)
starts the mock API with `SEED_STORE_DEMO=1` if port 4000 is free, runs
`npm run build` and `cap sync ios`, builds a Debug simulator app, installs it
fresh on the one iPhone 17 Pro Max simulator (or `--udid <id>`) with light
appearance and a 9:41 status bar, and walks the shot list in
`frontend/scripts/store-shots/shots.mjs`. The in-app driver, `tour.js`, goes
into that simulator build only and is removed from the synced web folder
right after Xcode copies it; it is never in `src/`, `dist/` or a release
build. It signs in through the real form and opens each route; the native
bars follow the route as they do for a tap. `store-assets/README.md` has the
details. Re-run it for each release whose UI changed, so the frames match
the binary under review. `npm run mobile:validate` checks that all eight
exist at 1320 x 2868.

The iPad frames come from `npm run store:screenshots --workspace frontend`
(Playwright), as before.

| #   | iPhone frame  | Real content                                                                                                                                                                                                                                                                                                                                             |
| --- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01  | Plants        | The Plants tab: the large title, the ⋯, filter and + buttons in the native navigation bar, the search field, and the list led by "Needs care": 5 plants with what each needs, its room, who holds it ("You", a member's initial, or up for grabs) and a round water button; then "Coming up" with 3 more. Each plant shows its photo.                    |
| 02  | Home          | Dana's Home tab with its large title: 8 plants, 4 due today, 1 overdue; "To do now" with the overdue Peace Lily up for grabs and today's Monstera held by Dana Whitfield.                                                                                                                                                                                |
| 03  | Plant detail  | The Monstera, opened from Plants (back chevron, title and ⋯ menu in the navigation bar): the status card ("Water today", "You · last by Marisol Reyes, 7 days ago", Watered and Snooze), the house rule ("Bottom-water this one") and the household's note. The thumbnail is its photo.                                                                  |
| 04  | Plant care    | The same page further down: the curated care tips for _Monstera deliciosa_ (light, water, humidity, notes) and its weekly watering task with its streak.                                                                                                                                                                                                 |
| 05  | Tasks         | The Tasks tab as a checklist: the large title, the filter button in the native navigation bar, and Today / Upcoming (5 each). "Overdue" leads with the Peace Lily (water, 1 day overdue, Bedroom, up for grabs), then "Today" with Aloe (up for grabs), Fiddle Leaf Fig ("T"), Golden Pothos ("M") and Monstera ("You"), each with a round check circle. |
| 06  | Household     | The Household tab: "Who's carrying the care", with each member's care in the last 30 days and jobs held now, and 4 jobs up for grabs.                                                                                                                                                                                                                    |
| 07  | Plant sitter  | The page Dana's "Long weekend" sitter link opens, in the app: what needs doing, in which room, with Done buttons, no account needed, and the date the link stops working. The capture creates the link.                                                                                                                                                  |
| 08  | Notifications | Settings, Notifications: the email reminder, the weekly digest and the household emails, as switches. No push setting: this release sends reminders by email.                                                                                                                                                                                            |

Google Play's `store-assets/google-play/phone/` has the same four web frames
as the iPad set, plus `app-icon-512.png` and `feature-graphic-1024x500.png`.

Known gaps in this set, carried over from `store-assets/README.md` and
still true — worth fixing before they're needed, not hidden:

- **The plant photos are not the household's own.** The iPhone capture
  gives each demo plant a photograph of its species from Wikimedia Commons
  (public domain or CC0), uploaded through the app's own photo
  upload. Sources, authors and licenses are in
  `store-assets/photo-credits.json` and `store-assets/README.md`. The iPad
  and Google Play frames still show the brand placeholder.
- **No caption overlays.** These are raw device frames; both stores support
  captioned marketing frames and most competitors use them.
- **No Android tablet screenshots**, despite the iPad frames proving the
  app runs on a tablet — Play down-ranks large-screen surfacing without
  7"/10" frames.
- **Four iPad and four Play frames.** Apple allows up to 10, Play up to 8.
  The iPhone set has 8, including the sitter page. The iPad and Play frames
  still show the website's layout with the menu drawer.
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

4. **One more, not from #469: a locked feature used to show a price with no
   way to pay. Fixed.** `LockedFeature` (gating `/chat`, the trip-sitter
   offer, and API key settings) showed "Included with Garden — $4.99 a month
   for the whole household" and a **Change plan** button inside the shells.
   Since #804 and #903 it checks `isNativeApp()` and shows only what the
   feature is and "Plan changes aren't available in the app." The 2026-10-04
   sweep closed the rest: the changelog's billing entries, the analytics
   "See plans" link, the trial notice's checkout line, the archive restore's
   "upgrade" wording, and the "Upgrade …" sentences in the server's plan
   refusals no longer appear in the app (`docs/mobile.md`, "Store payment
   rules"). One wording is left on purpose: the Terms page (a legal text)
   says paid plans "are available on the web" and are "not sold inside the
   mobile apps".

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
