# Mobile release checklist

## Pre-release

- [x] Production bundle variables are reproducible and beta mode is off.
- [x] Native HTTP handles API and presigned image uploads without weakening web CORS.
- [x] Account deletion (`/account`, reachable before household setup), AI
      response reporting (`ReportResponseControl` on every assistant answer),
      and the camera/photo purpose strings in `Info.plist` are implemented.
- [ ] Native purchase guards. `BillingSettings` and `/pricing` are gated;
      `LockedFeature` is not, so `/chat` shows a Seedling household a
      subscription price and an upgrade call to action inside the app. See
      `docs/mobile.md`, "Store payment rules".
- [x] `ios/App/App/PrivacyInfo.xcprivacy` declares what the shells send: 11
      data types, with `NSPrivacyTracking` false. The shells run the same web
      bundle, so they post `/telemetry/product` (Product Interaction, keyed to
      the Cognito sub and the household id) and `/telemetry/frontend` (web
      vitals as Performance Data, and sanitized error summaries as Crash Data,
      both keyed only to a random session id and not linked). Crash Data was
      the last one missing; it is declared from 0.37.1. `docs/APP-STORE.md` §2
      is the table to answer App Privacy from, and
      `validate-store-release.mjs` fails a build whose manifest drops any of
      the 11. If any of it is ever linked to a person for advertising, ad
      measurement or a data broker, `NSPrivacyTracking` is true, the domains
      go in `NSPrivacyTrackingDomains`, and App Tracking Transparency applies
      (a native prompt the WebView cannot show).
- [x] Store icons, Play feature graphic, metadata, and review-safe screenshots validate.
- [x] Screenshots are re-captured from a seeded store-demo household
      (`backend/src/local-server-store-demo.ts`, `SEED_STORE_DEMO=1`): the
      dashboard greets Dana, three named members hold work across the frames,
      eight plants sit in five rooms, and Tasks shows one overdue job up for
      grabs plus four due today. No frame carries a plant photograph — see
      the remaining gap in `store-assets/README.md`.
- [ ] Listing still says reminders are email-only. Native push is not
      implemented and production SMS is off, so this stays true until
      `docs/mobile.md`'s push work ships.
- [x] Android API 36 release bundle compiles with JDK 21.
- [ ] Apple Developer and Google Play accounts have accepted current
      agreements. Apple: enrolled and approved (Team ID `6X5YH93QNM`); the
      Paid Apps agreement is not needed while the app sells nothing. Play: not
      started, and Android is deferred.
- [ ] Reviewer account is seeded and its credentials are stored only in the store consoles.
- [ ] Android upload keystore is created, backed up, and exposed through the four `ANDROID_UPLOAD_*` environment variables.
- [ ] Deep links, in this order — the serving half is wired and gated
      (`npm run well-known:check`) and the iOS association file has landed, so
      what is left is the Android fingerprint and the app-side half. See
      `docs/mobile.md`, "The iOS association file".
  - [ ] `keytool -list -v` (or Play Console → Setup → App integrity) for the
        upload certificate's SHA-256 fingerprint → commit
        `frontend/public/.well-known/assetlinks.json`.
  - [x] Apple Developer → Membership for the Team ID → commit
        `frontend/public/.well-known/apple-app-site-association`. **Done** —
        the file is generated from `src/App.tsx` (`npm run aasa --workspace
frontend`) and carries the real Team ID; `npm run aasa:check` and
        `npm run well-known:check` both gate it, in `npm run verify` and in
        CI's Lint job. Both now also refuse the **Enrollment ID**
        (`ACKGM9XK9V`) by value — it is ten uppercase alphanumerics, so the
        shape check passed it, and a file carrying it deploys green while
        every universal link keeps opening Safari.
  - [ ] Deploy, then confirm both URLs return `200 application/json` on the
        live domain before touching the native projects. A missing file now
        answers 404 rather than the app shell, so this is checkable.
  - [ ] Only then: `@capacitor/app` + `appUrlOpen` handler, the
        `autoVerify="true"` intent-filter, and the Associated Domains
        entitlement. Doing these first makes Android 12+ record a failed
        verification and keep sending links to the browser.
- [ ] Xcode 26+, Apple team signing, and the explicit
      `net.familygreenhouse.app` App ID are configured. Xcode 26.6 is
      installed; the bundle identifier is explicit in both build
      configurations; `DEVELOPMENT_TEAM = 6X5YH93QNM` is now committed, so a
      fresh clone no longer stops at "Signing for 'App' requires a development
      team". What is left is Apple-side: the App ID needs the **Push
      Notifications** capability, because `App.entitlements` ships
      `aps-environment` and a profile cannot carry an entitlement its App ID
      lacks. Automatic signing normally adds the capability to the App ID on
      the first signed build; if Archive stops on "Provisioning profile
      doesn't include the aps-environment entitlement", enable it by hand
      under Certificates, Identifiers & Profiles → Identifiers →
      `net.familygreenhouse.app`.
- [ ] Physical iPhone, iPad, and Android smoke tests pass against production.

## Build and test

```bash
cp frontend/.env.mobile.production.example frontend/.env.mobile.production
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
npm run mobile:release -- frontend/.env.mobile.production
```

- [ ] Upload the signed AAB to Play internal testing, then the required closed test.
- [ ] Archive in Xcode, generate the privacy report, validate, and upload to internal TestFlight.
- [ ] Re-run login, token refresh, plant/task CRUD, camera and library uploads, chat reporting, offline recovery, and deletion from the uploaded builds.

## Submit and monitor

- [ ] Complete App Privacy/Data Safety, content/age ratings, app access, export compliance, and release notes.
- [ ] Use manual release after approval.
- [ ] Monitor authentication errors, upload failures, crashes, and account-deletion failures for the first 24 hours.

## Rollback triggers

- Login or token refresh fails on a store build.
- Image upload or account deletion fails for any tested native origin.
- Crash-free sessions fall below 99.5% or a new crash blocks a primary flow.
- Store review finds a privacy, AI-reporting, or payment-policy mismatch.

Before public release, remove the affected build from testing or stop the Play rollout. After release, remove it from sale/availability if necessary and upload a corrected build with a higher Android `versionCode` and iOS build number; store binaries cannot be replaced in place.
