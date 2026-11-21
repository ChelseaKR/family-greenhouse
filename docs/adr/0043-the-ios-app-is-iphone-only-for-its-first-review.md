# 0043 — The iOS app is iPhone-only for its first App Store review

**Status:** Accepted

**Date:** 2026-11-17

**Deciders:** Chelsea Kelly-Reif

**Related:** [ADR 0035](0035-the-ios-app-opens-signed-out-on-a-native-intro.md) (the native intro),
[ADR 0041](0041-apple-in-app-purchase-in-the-iphone-app.md) (In-App Purchase in the iPhone app).

## Context

The app has never passed App Review. Version 0.34.0 (build 3400) has sat at "Unresolved Issues"
since 2026-09-17 on a Guideline 2.1 information request, and the next submission is a first
review that also carries three subscriptions, a demo account, third-party AI consent and account
deletion. Every build so far targeted iPhone and iPad (`TARGETED_DEVICE_FAMILY = "1,2"`).

The iPad side carries risk that the iPhone side does not:

- The iPad screenshots in App Store Connect show the website's layout with its menu drawer, not
  the native frame, and Guideline 2.3.3 asks screenshots to show the app in use.
- iPad-only code paths (the floating tab bar, popover action sheets and print sheets, the
  three-column quiet-hours row) have needed several layout fixes (`frontend/tests/e2e/ipad-layout.spec.ts`,
  `frontend/tests/e2e/native-photo-buttons.spec.ts`) and have had less device time than the iPhone paths.
- App Review often tests on an iPad, and a web view at iPad width is where "a repackaged website"
  (Guideline 4.2) is easiest to argue.

## Decision

1. **The iOS target is iPhone only:** `TARGETED_DEVICE_FAMILY = 1` in both build configurations.
   On an iPad the App Store offers it as an iPhone app, which runs in iPhone compatibility mode
   at phone width, with the iPhone code paths.
2. **App Store Connect carries iPhone screenshots only** (the 6.9-inch set in
   `store-assets/app-store/iphone-6.9/`). The iPad frames stay in `store-assets/app-store/ipad-13/`
   for a later iPad release.
3. **`npm run mobile:validate` enforces it.** It fails if any build configuration targets anything
   but iPhone, so a regenerated Xcode project cannot bring iPad back without a new ADR.
4. `UISupportedInterfaceOrientations~ipad` stays in `Info.plist`. iOS ignores it for an
   iPhone-only app, and it is what an iPad release would need.

## Consequences

- Less to review and less layout to go wrong on the first submission. Reviewers can still open
  the app on an iPad, so it must work in compatibility mode; that is the iPhone layout, scaled.
- iPad owners get a scaled iPhone app, not an iPad layout, until iPad comes back.
- **iPad can come later, as an ordinary update:** set the family back to `1,2`, change the
  validator, add iPad screenshots, and supersede this record. Apple lets an iPhone app add iPad
  support in an update, but does not let an app that has shipped with iPad support drop it. So
  this is the direction that can still be changed after approval; staying universal would not be.
- The website and the Android app are unaffected.
