# Mobile release checklist

## Pre-release

- [x] Production bundle variables are reproducible and beta mode is off.
- [x] Native HTTP handles API and presigned image uploads without weakening web CORS.
- [x] Account deletion, AI response reporting, native purchase guards, camera disclosures, and privacy copy are implemented.
- [x] Store icons, Play feature graphic, metadata, and review-safe screenshots validate.
- [ ] Screenshots are re-captured from a seeded store-demo household. The
      current frames come from the mock backend's default `test@example.com`
      fixture: the dashboard greets "Test", the household has one member, and
      one plant and one task carry all four frames, so the shared-household
      pitch never appears. See `store-assets/README.md`.
- [ ] Listing still says reminders are email-only. Native push is not
      implemented and production SMS is off, so this stays true until
      `docs/mobile.md`'s push work ships.
- [x] Android API 36 release bundle compiles with JDK 21.
- [ ] Apple Developer and Google Play accounts have accepted current agreements.
- [ ] Reviewer account is seeded and its credentials are stored only in the store consoles.
- [ ] Android upload keystore is created, backed up, and exposed through the four `ANDROID_UPLOAD_*` environment variables.
- [ ] Deep links, in this order — the serving half is already wired and gated
      (`npm run well-known:check`), so what is left is the three values this
      repo cannot derive. See `docs/mobile.md`, "The serving half is ready".
  - [ ] `keytool -list -v` (or Play Console → Setup → App integrity) for the
        upload certificate's SHA-256 fingerprint → commit
        `frontend/public/.well-known/assetlinks.json`.
  - [ ] Apple Developer → Membership for the Team ID → commit
        `frontend/public/.well-known/apple-app-site-association`.
  - [ ] Deploy, then confirm both URLs return `200 application/json` on the
        live domain before touching the native projects. A missing file now
        answers 404 rather than the app shell, so this is checkable.
  - [ ] Only then: `@capacitor/app` + `appUrlOpen` handler, the
        `autoVerify="true"` intent-filter, and the Associated Domains
        entitlement. Doing these first makes Android 12+ record a failed
        verification and keep sending links to the browser.
- [ ] Xcode 26+, Apple team signing, and the explicit `net.familygreenhouse.app` App ID are configured.
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
