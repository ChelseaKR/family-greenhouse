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

## Build flow

```bash
cd frontend

# 1. Build the web bundle with PRODUCTION env vars. The bundle is baked into
#    the app binary — a web deploy does NOT update shipped apps.
VITE_API_URL=https://<prod-api> VITE_VAPID_PUBLIC_KEY=... npm run build

# 2. Copy it into the native projects (also available as `npm run mobile:sync`)
npx cap sync

# 3. Open the native IDEs
npx cap open android   # Android Studio (any OS)
npx cap open ios       # Xcode (macOS only)
```

`npx cap run android`/`npx cap run ios` builds and launches on a connected
device or emulator/simulator. iOS builds require a Mac (or a macOS CI runner
such as GitHub Actions `macos-` images); the iOS project uses Swift Package
Manager, so no CocoaPods setup is needed.

Because the binary pins a snapshot of the frontend, plan on shipping a store
release for user-facing frontend changes (or adopt a live-update service such
as Ionic Appflow/Capgo later). Backend/API changes reach the apps immediately.

## What differs inside the native shells

| Area               | Behavior                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Billing            | All purchase UI is hidden (`BillingSettings.tsx` gates on `isNativeApp()`). Native shows the current plan + usage read-only. See "Store payment rules" below — do not add purchase links without reading it.                                                                                                                                                               |
| Push notifications | Web push (service worker + VAPID) does not exist in the WebViews. The "This device" toggle in notification settings registers an APNs/FCM token via `@capacitor/push-notifications` and stores it with `POST /notifications/devices` (`backend/src/services/deviceTokens.ts`). **Capture-only for now** — see "Push notifications" below for what's left to actually send. |
| CORS               | The shells call the API from `capacitor://localhost` (iOS) / `https://localhost` (Android). Both are allowed via `native_app_origins` (infrastructure/modules/api) and the comma-separated `ALLOWED_ORIGIN` env the middleware splits (`backend/src/middleware/handler.ts`).                                                                                               |
| Safe areas         | `viewport-fit=cover` + `env(safe-area-inset-*)` padding on `body` (index.css) and the sticky mobile header (Layout.tsx) keep content clear of the notch/status bar/home indicator.                                                                                                                                                                                         |
| Auth               | Email/password against our API — no hosted-UI redirect, so no deep-link/custom-scheme handling is needed for login.                                                                                                                                                                                                                                                        |

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
keep the current "reader" model where users subscribe on the web and the apps
just honor the entitlement.

The public `/pricing` marketing page still renders in the apps (its CTAs go to
account signup, not checkout). If app review ever objects to visible prices,
hide that route behind `isNativeApp()` too.

## Push notifications

Current state: the apps **register** device tokens; nothing **sends** to them
yet (email/SMS reminders work in the apps from day one, so this is not
blocking). Registered tokens live under `USER#<id>` / `DEVICE#<hash>` in
DynamoDB so the sender covers all existing installs the day it ships.

Remaining work for delivery:

1. **Android (FCM):** create a Firebase project, add the app
   (`net.familygreenhouse.app`), download `google-services.json` into
   `frontend/android/app/`. The Gradle build already applies the
   google-services plugin only when that file exists, so the project builds
   fine without it (push simply won't work).
2. **iOS (APNs):** in the Apple Developer portal create an APNs key; in Xcode
   enable the **Push Notifications** capability on the App target (the
   AppDelegate APNs forwarding is already wired). Easiest delivery path is
   uploading the APNs key to the same Firebase project and sending everything
   through FCM.
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
- [ ] Google Play 1024×500 feature graphic (the launcher set already includes
      the required 512×512 icon).
- [ ] Screenshots per device class (6.7"/6.5" iPhone, 13" iPad if targeting
      iPad, phone + 7"/10" tablet for Play).

### Every submission

- [ ] Bump the native version numbers (`versionCode`/`versionName` in
      `android/app/build.gradle`; `MARKETING_VERSION`/`CURRENT_PROJECT_VERSION`
      in Xcode) — keep them in step with `package.json`.
- [ ] `npm run mobile:sync` with production env vars; verify login, plant
      CRUD, and reminders in a simulator/emulator.
- [ ] **Android:** Android Studio → Build → Generate Signed App Bundle (.aab),
      upload to a Play testing track, roll out.
- [ ] **iOS:** Xcode → Product → Archive → distribute to TestFlight, then
      submit for review.

### Review-proofing (first submission especially)

- [ ] Privacy policy URL (already live: the site's `/privacy` route) filled in
      on both store listings.
- [ ] Apple "App Privacy" + Play "Data safety" forms: declare account data
      (email, name), phone number (optional, SMS reminders), photos users
      upload, and crash/analytics telemetry (Sentry; self-hosted analytics).
- [ ] **Account deletion** must be reachable inside the app — it is
      (Settings → Account → delete via `DELETE /me`); point reviewers at it in
      the review notes.
- [ ] Apple Guideline 4.2 (minimum functionality): wrapped web apps get extra
      scrutiny. Native push + camera photo capture + the offline app shell are
      the differentiation to call out in review notes. If rejected under 4.2,
      the usual fixes are adding haptics, widgets, or native share — talk to
      review, don't resubmit blind.
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
