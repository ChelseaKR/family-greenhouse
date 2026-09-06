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

| Plugin                          | What it backs                                                                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@capacitor/push-notifications` | APNs/FCM device-token registration (`frontend/src/services/nativePush.ts`). Deliberately unreachable from the UI — see "Push notifications" below. |

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
  binary, not because anything caches at runtime. On iOS the shell is served
  from `capacitor://localhost`, a custom `WKURLSchemeHandler` scheme where
  service workers are unavailable, so `initPwaRegistration()`
  (`frontend/src/services/pwaRegistration.ts`) fails into its `console.warn`.
  The PWA offline story is a web-only feature.

Not present anywhere in the tree: deep links. The only Android `intent-filter`
is `MAIN`/`LAUNCHER`; `ios/App/App/App.entitlements` exists but declares only
`aps-environment`, no Associated Domains; and no `assetlinks.json` or
`apple-app-site-association` is served. So every link the backend mails —
invites, sitter links, the `/tasks?filter=due` reminder link, unsubscribe, the
calendar feed — opens the browser even for a user who has the app installed,
and asks them to sign in again. Closing that needs three things this repo
cannot supply on its own: `@capacitor/app` (nothing else delivers `appUrlOpen`
to the WebView), the release signing certificate's SHA-256 fingerprint for
`assetlinks.json`, and the Apple Team ID for `apple-app-site-association`.
Half of it is worse than none: an `intent-filter` with `autoVerify="true"` and
no matching `assetlinks.json` fails verification on Android 12+, so links keep
opening the browser while the manifest claims otherwise. Tracked in
[#469](https://github.com/ChelseaKR/family-greenhouse/issues/469) §2.

### The serving half is ready; the app half is not

The deploy and CDN path for the two association files is now wired and gated,
so the day the values above exist, publishing them is a one-file change rather
than a debugging session. Nothing app-side was enabled — no entitlement, no
`autoVerify` intent-filter, no invented fingerprint or Team ID — precisely
because half a setup is worse than none.

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

**What is still blocked, and on whom.** All three are maintainer-held values;
none can be derived from this repository:

| Needed                                                        | Where it comes from                                                                                    | What it unblocks                                                                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| SHA-256 fingerprint of the release/upload signing certificate | `keytool -list -v -keystore <upload.jks> -alias <alias>`, or Play Console → Setup → App integrity      | `assetlinks.json`, and only then the `autoVerify="true"` intent-filter                                               |
| Apple Team ID                                                 | Apple Developer → Membership                                                                           | `apple-app-site-association` (`<TeamID>.net.familygreenhouse.app`), and only then the Associated Domains entitlement |
| `@capacitor/app`                                              | `npm i @capacitor/app` in `frontend`, plus a row in the plugin table above and an `appUrlOpen` handler | the WebView actually navigating to the incoming URL instead of opening cold                                          |

The order matters and is the whole reason the app half is not staged here: the
association file has to be **live and verifiable at the domain first**, then
the intent-filter and entitlement. Reversed, Android 12+ records a failed
verification and keeps sending links to the browser.

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
| Billing            | All purchase UI is hidden (`BillingSettings.tsx` gates on `isNativeApp()`). Native shows the current plan + usage read-only. See "Store payment rules" below — do not add purchase links without reading it.                                                                                                                                                                                                                                     |
| Push notifications | Web push does not exist in the WebViews. Native push UI is hidden until APNs/FCM delivery is complete, so store builds do not promise reminders that cannot arrive. See "Push notifications" below.                                                                                                                                                                                                                                              |
| Networking         | `CapacitorHttp` patches `fetch`/`XMLHttpRequest` to use native networking. This lets iOS call the API and lets both shells PUT to presigned S3 image URLs without relying on WebView CORS. Keep API Gateway managed CORS enabled for the website: it makes gateway-generated JWT 401s readable so the web client can refresh tokens. `native_app_origins` remains an exact application-layer allowlist, not a reason to remove managed web CORS. |
| Safe areas         | `viewport-fit=cover` + `env(safe-area-inset-*)` padding on `body` (index.css) and the sticky mobile header (Layout.tsx) keep content clear of the notch/status bar/home indicator.                                                                                                                                                                                                                                                               |
| Auth               | Email/password against our API — no hosted-UI redirect, so no deep-link/custom-scheme handling is needed for login.                                                                                                                                                                                                                                                                                                                              |

## Store payment rules (read before touching billing UI)

Subscriptions here are "digital goods", so both stores forbid selling them in
the app through Stripe:

- **Apple (Guideline 3.1.1):** no buttons, external links, or calls to action
  that direct users to a purchase mechanism other than In-App Purchase. This
  is why the native billing screen shows only a neutral "Plan changes aren't
  available in the app." with **no URL**. Adding a "subscribe on our website"
  link is a rejection (US storefront external-link entitlements exist but
  need explicit approval — treat as a separate project).
- **Google Play (Payments policy):** same principle with Play Billing.

Options if in-app purchasing is ever wanted: implement StoreKit/Play Billing
(RevenueCat is the usual cross-store glue and can reconcile with Stripe), or
keep the current free companion model where the app honors an existing account
entitlement without directing users to a purchase flow.

The native `/pricing` route is purchase-free plan information; web prices and
billing help are not rendered inside the shells.

## Push notifications

Current state: native registration and delivery are disabled in the product UI.
Email/SMS reminders still work. Do not restore the toggle until the following
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
   outstanding here is the Apple-side key and the AppDelegate forwarding is
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

- [ ] **Apple Developer Program** — $99/year, <https://developer.apple.com>.
      Enrollment verification can take a few days.
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
      upload, and crash/analytics telemetry (Sentry; self-hosted analytics).
- [ ] **Account deletion** is reachable at `/account` even before household
      setup; point reviewers at Account & data → Delete my account.
- [ ] Apple Guideline 4.2 (minimum functionality): wrapped web apps get extra
      scrutiny, and **there is currently no native capability to point a
      reviewer at.** Do not write review notes that claim otherwise. This item
      used to name "camera photo capture + the offline app shell"; neither
      survives a reviewer opening the app. Photo capture is the WebView file
      picker, identical to the website in mobile Safari; the app opens offline
      because the bundle is inside the binary, which is what wrapping a web app
      means rather than a differentiator; and the one linked plugin, push
      notifications, is deliberately unreachable from the UI. All three are
      documented under "Native capabilities" above. Closing the gap is a
      product decision tracked in
      [#469](https://github.com/ChelseaKR/family-greenhouse/issues/469) — the
      candidates are native camera capture, Universal Links / App Links, or
      finishing push delivery. A 4.2 rejection is a multi-week loop, so decide
      before submitting rather than after. If rejected under 4.2, the usual
      fixes are haptics, widgets, or native share — talk to review, don't
      resubmit blind.
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
