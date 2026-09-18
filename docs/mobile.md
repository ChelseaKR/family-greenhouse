# Mobile apps (iOS + Android)

The mobile apps are the **same built web bundle** (`frontend/dist`) wrapped in
native [Capacitor](https://capacitorjs.com) shells. There is no second
frontend: React code, i18n catalogs, and the API client are shared 1:1 with
the web app. The native projects live in `frontend/ios` and `frontend/android`
and are committed source; the web assets copied into them by `npx cap sync`
are build artifacts and gitignored.

- App ID: `net.familygreenhouse.app` (both platforms)
- Config: `frontend/capacitor.config.ts`
- Platform detection: `frontend/src/lib/platform.ts` (`isNativeApp()`), which
  reads the injected `window.Capacitor` global so web visitors never download
  the Capacitor runtime.

## Native capabilities

This is the whole list. `scripts/validate-store-release.mjs` asserts that the
table names exactly the Capacitor plugins in `frontend/package.json`, and that
both native projects actually link each one — so a plugin cannot be added,
removed, or left un-synced without this table moving with it.

<!-- capacitor-plugins:start -->

| Plugin                          | What it backs                                                                                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@capacitor/app`                | `appUrlOpen` delivery for iOS Universal Links (`frontend/src/services/nativeDeepLinks.ts`). Android App Links are not wired yet — see "Deep links" below. |
| `@capacitor/push-notifications` | APNs/FCM device-token registration (`frontend/src/services/nativePush.ts`). Deliberately unreachable from the UI — see "Push notifications" below.        |

<!-- capacitor-plugins:end -->

Everything else the apps do is the same web code running in a WebView. Two
things that look native and are not, because both have been written into
review notes before and neither is true:

- **Photos.** Every photo path is a plain `<input type="file">`
  (`PlantImageUpload.tsx`, `AddPlantPage.tsx`, `LeafHealthCard.tsx`,
  `SitterPhotoBack.tsx`, `CaretakerPage.tsx`). There is no `@capacitor/camera`.
  `LeafHealthCard` adds `capture="environment"`, which makes iOS open the
  camera directly from the picker — **this is why `NSCameraUsageDescription`
  and `NSPhotoLibraryUsageDescription` are in `Info.plist` and they must stay**;
  iOS terminates the app if a purpose string is missing when the picker opens.
  They are load-bearing for the WebView picker, not leftovers from a camera
  plugin. What they are not is a native capability a reviewer can distinguish
  from the mobile website.
- **Offline.** The shells work offline because `dist/` is copied into the
  binary, not because anything caches at runtime. The PWA service worker is
  a web-only feature, and `initPwaRegistration()`
  (`frontend/src/services/pwaRegistration.ts`) no longer registers it inside
  the shells. On iOS it never could: the shell is served from
  `capacitor://localhost`, a custom `WKURLSchemeHandler` scheme where service
  workers are unavailable. On Android it did. The shell is served from
  `https://localhost`, so the worker precached the whole build again (148
  files, about 3.3 MB, measured on an API 36 emulator) and answered launches
  from that copy. The first launch after a store update therefore ran the
  previous build until the new worker took over and reloaded the page. The
  shells now remove a worker an earlier build left behind, along with its
  caches.

### Deep links

**iOS: wired in the app, not yet in a shipped build.**
`frontend/public/.well-known/apple-app-site-association` carries the real
Apple Team ID and is the SERVING side of iOS universal links. It is live at
the domain, and Apple's CDN
(`https://app-site-association.cdn-apple.com/a/v1/familygreenhouse.net`)
serves it too — checked 2026-09-17, after a stretch of cached 404s — which is
the "live and Apple-verified first" precondition this section set for the app
side. The APP side landed in #803: `ios/App/App/App.entitlements` declares
`com.apple.developer.associated-domains` (`applinks:familygreenhouse.net`),
`@capacitor/app` is installed and linked into both native projects, and
`frontend/src/services/nativeDeepLinks.ts` (started from `main.tsx`) turns the
`appUrlOpen` event into an in-app navigation via `history.pushState` + a
manual `popstate` dispatch (`<BrowserRouter>` only re-syncs on `popstate`,
which `pushState` does not fire on its own). `AppDelegate.swift` already
forwarded `continue userActivity` to `ApplicationDelegateProxy` before any of
this — nothing to add there.

None of that reaches a user until an iOS build carrying it is archived and
installed: the binary pins its own copy of the frontend and its entitlements
(see "Build flow"), and 0.34.0 — the first submitted build — predates #803.
Before naming universal links in review notes, tap a familygreenhouse.net link
from Mail or Notes on a device running that build and confirm it opens the
app.

**Still outstanding, and on whom.** Adding a new entitlement re-requests a
capability from the Apple Developer portal the same way Push Notifications
did (#469 §3) — expect to enable Associated Domains on the App ID and redo the
Signing & Capabilities dance (or at minimum regenerate/reselect the Release
provisioning profile) on the next archive. Android is untouched: the only
`intent-filter` is `MAIN`/`LAUNCHER`, and there is no `assetlinks.json` — that
file needs the SHA-256 fingerprint of the release/upload signing certificate
(`keytool -list -v` against the upload keystore, or Play Console → Setup → App
integrity), which is a maintainer-held value nothing in this repo can derive.
Until Android's half lands, every link the backend mails — invites, sitter
links, the `/tasks?filter=due` reminder link, unsubscribe, the calendar feed —
opens the browser for an Android user who has the app installed, and asks them
to sign in again. On iOS the same links open the app once a build carrying
#803 is installed.

Half of it is worse than none, which is why the remaining Android piece stays
staged in the same fixed order this section already established: an
`intent-filter` with `autoVerify="true"` and no matching `assetlinks.json`
fails verification on Android 12+, so links keep opening the browser while the
manifest claims otherwise. Tracked in
[#469](https://github.com/ChelseaKR/family-greenhouse/issues/469) §2.

### The iOS association file

`frontend/public/.well-known/apple-app-site-association` is **generated**, not
hand-written: `npm run aasa --workspace frontend` derives it from the
`<Routes>` table in `src/App.tsx` via `frontend/scripts/app-site-association.mjs`,
and `npm run aasa:check` (a step of `npm run verify` and of CI's Lint job)
fails if the committed bytes are not what the generator produces. The file is
a second copy of the route table, and every second copy in this repository has
drifted (#615, #719, #721); the two directions it would drift in are a claimed
path the app no longer routes (the app opens onto "Nothing growing here") and
a new route nobody claimed (its links keep opening Safari).

**What is claimed, and what is deliberately not.** The claim is a decision per
declared route, recorded in `ROUTE_POLICY`; a route App.tsx declares and the
policy does not classify fails the gate, so "no" is never the silent default.
24 of the 47 declared routes are claimed by 22 components. The 23 that stay in
the browser are the marketing and content pages (including `/pet-safe/:slug`
and `/gift`, both added after this count was first written), the email-link
auth routes (`/login`, `/register`, `/confirm-email`, `/reset-password`,
`/forgot-password`, `/welcome`) — a confirmation link is followed once, often
on a device that does not have the app — and `/account-deletion`. That last
one is not a judgement call: App Review checks that account deletion is
reachable, and a deletion route that opens the app strands the person who
cannot sign in and wants their data gone. It sits one wildcard away from the
claimed `/account`, so the gate asserts explicitly that no component matches
it.

**Wildcards are read the conservative way.** Apple's two primary sources
disagree about whether `*` crosses a `/` — the documentation's example
comments read as prefix matching, while WWDC19 session 717 says matching works
"the same way it is in terminal". The generator treats `*` as one path segment
that never crosses a slash, which is correct under either reading: the extra
components that reading emits are harmless supersets if Apple is more
permissive, whereas the opposite choice is wrong-and-silent if Apple is
stricter. The visible consequence is that `/sit/:token/brief` gets its own
component, while `/plants/new`, `/plants/import` and
`/household/caretaker-report` are each one segment below a claimed prefix and
are covered by `/plants/*` and `/household/*` without being restated.

**The Team ID cannot be a placeholder — or the Enrollment ID.**
`scripts/check-well-known.mjs` fails on the `TEAMID_PENDING` sentinel, on a
missing or empty `appIDs`, and on anything that is not exactly ten uppercase
alphanumerics before the bundle identifier. It used to say that last rule also
caught the Enrollment ID. It did not: `ACKGM9XK9V` is also ten uppercase
alphanumerics, and substituting it for `TEAM_ID` left `npm run aasa`,
`npm run aasa:check` and `npm run well-known:check` all green while the
published file claimed the wrong team. The Enrollment ID is now refused BY
VALUE (`ENROLLMENT_ID` and `teamIdProblem()` in
`frontend/scripts/app-site-association.mjs`), in the generator as well as the
checker, so `npm run aasa` refuses to write the file rather than only refusing
to bless it afterwards. All three deploy paths carry the same refusal inline, because
`scripts/deploy.sh` is run by hand and CI is not the last thing that can
publish this object. A wrong Team ID is the most expensive defect the file can
carry: it parses, uploads, caches, and is fetched successfully by Apple while
every universal link silently keeps opening Safari.

### The serving half is ready; the Android app half is not

The deploy and CDN path for both association files is wired and gated, so
`assetlinks.json` remains a one-file change the day the Android fingerprint
exists. The iOS app half is now enabled (Associated Domains entitlement,
`@capacitor/app`, see "Deep links" above); Android's is not — no
`autoVerify` intent-filter, no invented fingerprint — for the same reason iOS
waited: half a setup is worse than none.

**What is ready.** Drop a file at `frontend/public/.well-known/assetlinks.json`
or `frontend/public/.well-known/apple-app-site-association`, and:

- Both CD workflows and `scripts/deploy.sh` upload it explicitly, with
  `--content-type application/json` and `max-age=300`. The uploads are guarded
  on the file existing, so they are no-ops until it does.
- The immutable asset sync excludes `.well-known/*`, so nothing else can claim
  those keys. This matters: before, `assetlinks.json` was excluded from the
  first sync by its `*.json` filter and not picked up by the second sync's
  `*.html` filter, so **no sync uploaded it at all** and the deploy still went
  green; `apple-app-site-association` is extensionless, so it matched no
  exclude and went up with a 1-year immutable cache and a guessed
  `binary/octet-stream`.
- The CloudFront viewer-request function passes `/.well-known/` through
  untouched. Without that, `apple-app-site-association` — extensionless by
  Apple's spec — was rewritten to `/app-shell.html`, so Apple would have
  fetched `200 text/html` no matter what the deploy uploaded. Passing it
  through also means a missing file answers an honest 404 instead of a 200
  carrying HTML, which is the difference between Android's verifier reporting
  "not found" and reporting a JSON parse error.
- `npm run well-known:check` (`scripts/check-well-known.mjs`, a step in
  `npm run verify`) fails if any of that is removed, or if a file appears in
  `frontend/public/.well-known/` that the deploy path does not name or that is
  not valid JSON.

**What is still blocked, and on whom.** One maintainer-held value remains,
and it cannot be derived from this repository:

| Needed                                                        | Where it comes from                                                                               | What it unblocks                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| SHA-256 fingerprint of the release/upload signing certificate | `keytool -list -v -keystore <upload.jks> -alias <alias>`, or Play Console → Setup → App integrity | `assetlinks.json`, and only then the `autoVerify="true"` intent-filter |

Apple Team ID, the Associated Domains entitlement, and `@capacitor/app` are
all done — see "Deep links" above. The order matters for Android the same way
it mattered for iOS: the association file has to be **live and verifiable at
the domain first**, then the intent-filter. Reversed, Android 12+ records a
failed verification and keeps sending links to the browser.

## Build flow

```bash
# One-time local setup; the populated file is gitignored.
cp frontend/.env.mobile.production.example frontend/.env.mobile.production

# Validates versions, metadata, assets, secrets hygiene, production env,
# source-map removal, and synchronized native bundles. With JAVA_HOME set to
# JDK 21 it also produces the unsigned release AAB.
npm run mobile:release -- frontend/.env.mobile.production

cd frontend
npx cap open android
npx cap open ios
```

`npx cap run android`/`npx cap run ios` builds and launches on a connected
device or emulator/simulator. iOS builds require a Mac (or a macOS CI runner
such as GitHub Actions `macos-` images); the iOS project uses Swift Package
Manager, so no CocoaPods setup is needed.

Because the binary pins a snapshot of the frontend, plan on shipping a store
release for user-facing frontend changes (or adopt a live-update service such
as Ionic Appflow/Capgo later). Backend/API changes reach the apps immediately.

Keep `VITE_CHAT_STREAM_URL` unset in store builds for now. Capacitor's native
HTTP bridge is used for ordinary API requests and image uploads, while the
streaming client expects an incrementally readable browser `ReadableStream`.
With no stream URL, chat uses the supported synchronous API endpoint.

## What differs inside the native shells

| Area               | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Billing            | `BillingSettings.tsx` gates on `isNativeApp()`, so the billing screen is read-only, and since #804 so is every other purchase surface: `LockedFeature` shows what a paid feature is with no price and no ask, and `AskToUpgrade` renders only inside the web-only plan grid. One sentence on the billing screen still points outside the app — see "Store payment rules" below, and do not add purchase links without reading it.                |
| Push notifications | Web push does not exist in the WebViews. Native push UI is hidden until APNs/FCM delivery is complete, so store builds do not promise reminders that cannot arrive. See "Push notifications" below.                                                                                                                                                                                                                                              |
| Back (Android)     | `nativeBackButton.ts` listens through `@capacitor/app`: back closes an open dialog, menu or the drawer first, then goes back in the app, and on the first screen moves the app to the background like any Android app. It was a no-op there before. Predictive back works: the handler is switched off whenever back would leave, so Android animates it.                                                                                        |
| Networking         | `CapacitorHttp` patches `fetch`/`XMLHttpRequest` to use native networking. This lets iOS call the API and lets both shells PUT to presigned S3 image URLs without relying on WebView CORS. Keep API Gateway managed CORS enabled for the website: it makes gateway-generated JWT 401s readable so the web client can refresh tokens. `native_app_origins` remains an exact application-layer allowlist, not a reason to remove managed web CORS. |
| Safe areas         | `viewport-fit=cover` + `env(safe-area-inset-*)` padding on `body` (index.css) and the sticky mobile header (Layout.tsx) keep content clear of the notch/status bar/home indicator.                                                                                                                                                                                                                                                               |
| Signed-out start   | A signed-out native `/` redirects to `/login` (`App.tsx`), so the shells open on sign-in rather than the marketing landing page, and `main.tsx` does not hydrate the prerendered landing markup the binary still carries. `PricingGrid` renders nothing natively. See the Guideline 4.2 item under "Review-proofing".                                                                                                                            |
| Auth               | Email/password against our API — no hosted-UI redirect, so no deep-link/custom-scheme handling is needed for login.                                                                                                                                                                                                                                                                                                                              |

## Store payment rules (read before touching billing UI)

Subscriptions here are "digital goods", so both stores forbid selling them in
the app through Stripe:

- **Apple (Guideline 3.1.1):** no buttons, external links, or calls to action
  that direct users to a purchase mechanism other than In-App Purchase. This
  is why the native billing screen shows a neutral "Plan changes aren't
  available in the app." with **no URL** (one sentence for a household whose
  payment is failing is the exception; see below). Adding a "subscribe on our
  website" link is a rejection (US storefront external-link entitlements
  exist but need explicit approval — treat as a separate project).
- **Google Play (Payments policy):** same principle with Play Billing.

Options if in-app purchasing is ever wanted: implement StoreKit/Play Billing
(RevenueCat is the usual cross-store glue and can reconcile with Stripe), or
keep the current free companion model where the app honors an existing account
entitlement without directing users to a purchase flow.

The native `/pricing` route is purchase-free plan information; web prices and
billing help are not rendered inside the shells.

**The locked-feature card is gated too (#804).** `LockedFeature`
(`frontend/src/components/LockedFeature.tsx`) renders on `/chat`
(`feature="chat"`), on the trip-sitter offer (`away_kit`) and in API key
settings (`api_keys`) — the first screen a reviewer on a free-tier store
build reaches after reading about the chat assistant. It used to show a
subscription price ("Included with Garden — $4.99 a month"), a **Change plan**
button and **"Ask <admin> to upgrade"** inside the shells. It now checks
`isNativeApp()`: native shows what the feature is and the same neutral
"Plan changes aren't available in the app." as the billing screen, with no
price and no ask; the web keeps the full card.
`frontend/tests/unit/components/LockedFeature.test.tsx` ("inside the native
(Capacitor) shells") holds it.

**One sentence still points outside the app.** A household whose payment is
failing sees, on the read-only billing screen, "Open Family Greenhouse in a
web browser to update the card." (`settings.billing.paymentFailedActionNative`,
#767). It carries no URL and no button, and a reviewer's fresh account never
reaches it, but it is an instruction to pay somewhere other than In-App
Purchase. Keep it or cut it deliberately; do not copy its pattern onto a
surface a reviewer can reach.

## Push notifications

Current state: native registration and delivery are disabled in the product UI.
Email reminders still work; SMS is built but switched off in production (see
`notifications.md`). Do not restore the toggle until the following
delivery work is complete and verified end to end.

This is now enforced rather than remembered. `scripts/validate-store-release.mjs`
treats a call site for `registerNativePush()` anywhere in `frontend/src` as
"the push UI is reachable", and from that point requires the committed iOS
entitlements below in every mode, plus `google-services.json` in
`--production`. Wiring the toggle back up without the delivery material fails
the build instead of shipping a reminder switch that cannot deliver.

Remaining work for delivery:

1. **Android (FCM):** create a Firebase project, add the app
   (`net.familygreenhouse.app`), download `google-services.json` into
   `frontend/android/app/`. The Gradle build already applies the
   google-services plugin only when that file exists, so the project builds
   fine without it (push simply won't work).
2. **iOS (APNs):** in the Apple Developer portal create an APNs key, and
   enable the Push Notifications capability for the App ID. The Xcode half is
   **already committed** and no longer a manual step:
   `ios/App/App/App.entitlements` declares `aps-environment` and both build
   configurations set `CODE_SIGN_ENTITLEMENTS`, so a fresh clone archives with
   the entitlement instead of silently omitting it. The value is
   `$(APS_ENVIRONMENT)`, set to `development` in Debug and `production` in
   Release, so an archive cannot ship a sandbox APNs environment — the failure
   that mints tokens the production gateway rejects and reads, from the
   backend, as a delivery bug. `tests/unit/config/iosEntitlements.test.ts`
   holds all of that; `scripts/validate-store-release.mjs` additionally
   requires it once `registerNativePush()` has a call site. What is still
   outstanding here is only the Apple-side key; the AppDelegate forwarding is
   already wired. Easiest delivery path is uploading the APNs key to the same
   Firebase project and sending everything through FCM.
3. **Backend sender: written and wired; unconfigured.** `notifier.sendDevicePush`
   is the sibling of `sendBrowserPush`, and `services/fcmNotifier.ts` is the
   FCM HTTP v1 transport behind it (RS256 service-account JWT → OAuth2 access
   token → `messages:send`, no `firebase-admin` in the Lambda bundle). It runs
   on the same `browser` preference and the same reminder marker as web push,
   because to a user they are one channel reached over two transports, and it
   prunes tokens FCM reports as `UNREGISTERED` — the native form of the
   404/410 cleanup the web-push path does. `INVALID_ARGUMENT` deliberately
   does NOT prune: FCM returns it for a malformed message as well as a
   malformed token, so pruning on it would delete the whole installed base's
   registrations over one bad payload.

   What is left is credentials, not code. The Lambdas read the Firebase
   service-account JSON from the Secrets Manager id in
   `FCM_SERVICE_ACCOUNT_SECRET_ID` (Terraform:
   `fcm_service_account_secret_id`), which is **blank in every environment**.
   While it is blank the sender makes no network call and no Secrets Manager
   call: it logs one `device_push_unconfigured` line per Lambda container and
   the reminder path behaves exactly as it did before it existed. Filling it
   in needs items 1 and 2 above to have happened first — the Firebase project
   issues the service account, and the APNs key uploaded to that project is
   what makes iOS work.

   Delivery is still not verified end to end, and the toggle stays off until
   it is. Restoring it is a separate frontend change (a `registerNativePush()`
   call site), and `scripts/validate-store-release.mjs` will then require
   `google-services.json` and the iOS entitlements.

## Store submission checklist

### One-time setup

- [x] **Apple Developer Program** — $99/year, <https://developer.apple.com>.
      Enrolled and approved; Team ID `6X5YH93QNM`. The Enrollment ID shown
      while the application was pending is a different number of the same
      shape — see "The iOS association file".
- [ ] **Google Play Console** — $25 one-time, <https://play.google.com/console>.
      New personal accounts must run a closed test (≥12 testers for 14 days)
      before production access is granted — start this early.
- [x] App icons and launch screens: branded iOS/Android assets are generated
      from the greenhouse mark by `frontend/scripts/render-brand-assets.sh`.
- [x] Google Play 1024×500 feature graphic and both store icons in
      `store-assets/`.
- [x] Review-safe screenshots for 6.9" iPhone, 13" iPad, and Android phone.
      Regenerate with `npm run store:screenshots --workspace frontend`.

### Every submission

- [ ] Bump the native version numbers (`versionCode`/`versionName` in
      `android/app/build.gradle`; `MARKETING_VERSION`/`CURRENT_PROJECT_VERSION`
      in Xcode) — keep them in step with `package.json`.
- [ ] Run `npm run mobile:release -- frontend/.env.mobile.production`; verify
      login, account deletion, plant/task CRUD, photo uploads, and AI reporting
      on physical devices.
- [ ] **Android:** Android Studio → Build → Generate Signed App Bundle (.aab),
      upload to a Play testing track, roll out.
- [ ] **iOS:** Xcode → Product → Archive → distribute to TestFlight, then
      submit for review.

### Review-proofing (first submission especially)

- [ ] Privacy policy (`/legal/privacy`), support (`/support`), and account
      deletion (`/account-deletion`) URLs filled in on both store listings.
- [ ] Apple "App Privacy" + Play "Data safety" forms: declare account data
      (email, name), phone number (optional, SMS reminders), photos users
      upload, and the analytics rails as they actually ship — product
      interaction keyed to the account id, crash and performance data — under
      the Analytics purpose, matching `ios/App/App/PrivacyInfo.xcprivacy`
      entry for entry. Sentry only if a DSN is configured for the store build.
      See the privacy manifest item in `docs/mobile-release-checklist.md`.
- [ ] **Account deletion** is reachable at `/account` even before household
      setup; point reviewers at Account & data → Delete my account.
- [ ] Apple Guideline 4.2 (minimum functionality): wrapped web apps get extra
      scrutiny, so the argument is built from what a reviewer can see that
      mobile Safari does not do, and nothing else. Name only what is true of
      the build being submitted, and check each item on a device running that
      build first.
  - **The first screen is the app, not the website.** Signed out, the shells
    open on sign-in (`App.tsx` sends a native `/` to `/login`). Up to and
    including 0.36.0 they opened on the marketing landing page, which is the
    screen a reviewer sees before typing the demo credentials. That page had
    its header under the status bar and Dynamic Island, a browser-window
    mockup captioned "familygreenhouse.net", and the live plan catalog with
    prices, plan buttons and trial terms. The prices are a 3.1.1 problem on
    their own; `PricingGrid` now renders nothing inside the shells in case
    another page embeds it later.
  - **Links open the app.** iOS Universal Links are wired (#803; "Deep links"
    above). With a build that carries them, tapping a familygreenhouse.net
    link from one of the app's emails (an invite, a sitter link, a task
    reminder) opens the native app instead of Safari. It doesn't help 0.34.0,
    which predates it. Android App Links still wait on the
    signing-certificate fingerprint.
  - **Everything in "Native capabilities" above.** The validator checks that
    table against the installed plugins and both native projects, so it is
    the list to write review notes from. Keep adding to it as native
    behavior lands. A row that isn't in the table isn't in the app.
  - **What is not an argument.** The WebView file picker behaves exactly like
    mobile Safari's. Opening offline is what a bundled web app does anyway,
    so it doesn't count as a feature. Push delivery is still off end to end,
    tracked in
    [#469](https://github.com/ChelseaKR/family-greenhouse/issues/469).

  A 4.2 rejection is a multi-week loop. Talk to review, don't resubmit
  blind.

- [ ] Demo credentials for a seeded household in the review notes (both
      stores log into the app during review).

## Local development against the shells

```bash
# Terminal 1: mock API
npm run dev --workspace backend   # local-server on :4000

# Terminal 2: web build served to the emulator with live reload
cd frontend
npx cap run android -l --external   # or: npx cap run ios -l --external
```

`--external` binds Vite to the LAN so the device/emulator can reach it; the
Android emulator reaches the host's localhost API at `10.0.2.2:4000`, so set
`VITE_API_URL=http://10.0.2.2:4000` for that flow.
