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

Not present anywhere in the tree: deep links (the only Android `intent-filter`
is `MAIN`/`LAUNCHER`, there is no iOS entitlements file, and no
`assetlinks.json` or `apple-app-site-association` is served), so every link the
backend mails opens the browser even for a user who has the app installed.

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
2. **iOS (APNs):** in the Apple Developer portal create an APNs key; in Xcode
   enable the **Push Notifications** capability on the App target (the
   AppDelegate APNs forwarding is already wired). Commit the resulting
   `App.entitlements` and its `CODE_SIGN_ENTITLEMENTS` build setting — an
   uncommitted Xcode capability has to be redone on every fresh clone, and
   without an `aps-environment` entitlement `PushNotifications.register()`
   fails at runtime. Easiest delivery path is uploading the APNs key to the
   same Firebase project and sending everything through FCM.
3. **Backend sender:** a `sendDevicePush` sibling to
   `notifier.sendBrowserPush` that calls the FCM HTTP v1 API with the stored
   tokens, pruning tokens FCM reports as dead (mirror the 404/410 cleanup the
   web push path does). Needs the Firebase service-account JSON in Secrets
   Manager + reminder Lambda wiring.

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
