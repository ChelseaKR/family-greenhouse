# 0036 — The iOS app asks for an App Store rating after care is recorded, with Apple's own sheet

**Status:** Accepted

**Date:** 2026-10-12

**Deciders:** Chelsea Kelly-Reif

**Related:** [ADR 0034](0034-the-app-stays-signed-in.md) and [ADR 0035](0035-the-ios-app-opens-signed-out-on-a-native-intro.md)
(app-target plugins, gated on the bridge's plugin headers); `docs/mobile.md`, "Ratings (iOS)";
`frontend/ios/App/App/NativeReviewPlugin.swift`; `frontend/src/lib/reviewPromptState.ts`,
`frontend/src/services/nativeReview.ts`, `frontend/src/features/settings/AboutSettings.tsx`.

## Context

The owner, 2026-10-12, across the iOS apps: ask for App Store ratings at a good moment, plus a
"Rate" row, with no incentives and no sentiment pre-filter.

The app has no ratings. In App Store search the first ratings carry the most weight, and the only
ask Apple allows inside an app is its own rating sheet (StoreKit), which iOS shows at most three
times in 365 days and never in TestFlight. Guideline 5.6.1 forbids custom review prompts, rewards
for a rating, and asking "do you like the app?" first to send only the happy people to the store.

Constraints that shaped the decision:

- The ask must come after something went well, not at launch, not while signing in or setting up.
- An app-target plugin must never be driven without its native half (ADR 0034 measured a frozen
  page), so the web must gate on the bridge's plugin header, never on the platform alone.
- The website and Android must not change.

## Decision

1. **A local Capacitor plugin, `NativeReview`, hands the request to StoreKit.** One method,
   `requestReview`, which calls `AppStore.requestReview(in:)` (iOS 16 and later;
   `SKStoreReviewController.requestReview(in:)` on iOS 15) on the web view's scene when it is in
   the foreground, and answers `{ requested }`. It follows the `Print` pattern: registered by
   `MainViewController`, built by the Xcode project, listed in `docs/mobile.md`. It carries no
   words.

2. **The good moment is care that the server accepted.** The three places that already play the
   success haptic for a completed task (the task list and plant pages, Today across homes, and a
   notification's Done button) call `noteCareDone()`. Guest pages (sitter, caretaker, wall display,
   plant tag) do not: those people are not the app's owner.

3. **The web keeps the rules, stricter than Apple's.** In `lib/reviewPromptState.ts`, pure over a
   passed-in clock, version, launch and path: three completions since the last ask or install;
   not in the launch that recorded the first of them, so never on a first launch; never on a
   sign-in or setup screen; at most once per app version (`App.getInfo().version`) and at least 120
   days apart. The ask waits 1.5 seconds after the success toast and checks again that the page is
   visible and still allowed. Only `requested: true` counts as an ask; a request with no
   foreground scene (a notification action handled in the background) leaves the count, so the
   next completion may try. The state is one `localStorage` key, which iOS deletes with the app.

4. **No screen before the sheet, nothing for a rating.** Everyone who reaches the moment gets the
   same Apple sheet.

5. **A "Rate Family Greenhouse" row in Settings → About, iOS only.** A plain link to the App
   Store's write-review page for app 6812185914. The shell already hands outside links to iOS
   (Capacitor's navigation policy calls `UIApplication.open`), so the row needs no plugin.

6. **Gated on the header.** `hasNativeReview()` is true only on iOS when `Capacitor.PluginHeaders`
   lists `NativeReview` with `requestReview` and `App` with `getInfo`. The plugin's JavaScript is
   a separate chunk, loaded only when the rules could say yes.

## Consequences

- A person who records care regularly is asked once, in a moment that went well, by the system
  sheet; most people are never asked more than three times a year, and nobody more than once per
  version.
- Whether the sheet actually appeared is unknowable: StoreKit does not say. The web records the
  request, not a rating.
- It does nothing until a store build carries it: the plugin is in the binary, and the binary
  carries its own copy of the web bundle. TestFlight never shows the sheet, so it is checked on
  the simulator (where StoreKit shows it) or after release.
- The write-review link opens a "not available" page until the app is live in the store.
- Android keeps neither the ask nor the row. Google Play's In-App Review API would be a separate
  decision.
