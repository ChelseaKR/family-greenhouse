# 0035 — The iOS app opens signed-out on a native intro that hands off to the web's own sign-in and sign-up

**Status:** Accepted

**Date:** 2026-10-11

**Deciders:** Chelsea Kelly-Reif

**Related:** [ADR 0034](0034-the-app-stays-signed-in.md) (the keychain plugin, gated on the
bridge's plugin headers); `docs/mobile.md`, "The signed-out intro (iOS)" and "Store payment rules";
`frontend/ios/App/App/NativeIntroPlugin.swift`, `NativeIntroView.swift`, `NativeIntroModel.swift`;
`frontend/src/config/nativeIntro.ts`, `frontend/src/features/auth/useNativeIntro.ts`,
`frontend/src/lib/nativeIntroState.ts`.

## Context

The owner, 2026-10-11: "for the ios app create a much more interactive / user friendly login /
onboard state when user isn't logged into account - onboarding should be fancy and ios native".

Since the Guideline 4.2 work, a signed-out `/` in the shells redirects to `/login`, so the first
thing a new install shows is the website's sign-in form in a web view: an email field, a password
field and a "Sign up free" link. Nothing on it says what the app is for, and nothing on it is
native. Inside the app everything else a person touches first (the tab bar, the navigation bar,
alerts, the Add care task sheet) is already UIKit or SwiftUI through the app's own plugins.

Constraints that shaped the decision:

- Sign-in and sign-up must not change. The session model (Cognito through our API, the refresh
  token in the keychain since ADR 0034) and the forms' validation, two-step verification and error
  wording are the web's, shared with the website and covered by its tests.
- App Review reads the first screen. Nothing on it may mention plans, prices, gifts, trials or
  purchases (Guideline 3.1.1, "Store payment rules").
- A plugin must never be driven without its native half. ADR 0034 measured what happens when it
  is: the page stops answering. A build without the new plugin, and Android, must behave exactly as
  today.
- Every word goes through the en and es catalogs.

## Decision

1. **A local Capacitor plugin, `NativeIntro`, presents a SwiftUI intro over the web's sign-in
   screen.** It follows the app-target plugin pattern (`Print`, `NativeChrome`): three Swift
   files, registered by `MainViewController`, built by the Xcode project. `present` shows the
   intro full screen (`overFullScreen`, cross-dissolve, so the web view keeps running underneath)
   and answers which door was tapped; `dismiss` takes it down when the web leaves the sign-in
   screen first.

2. **The intro only presents and reports.** Its last page has two doors, "Create account" (the
   sign-up screen's own button words) and "I already have an account". The answer is
   `{ choice: 'create' | 'signIn' | null }`. The web opens its existing sign-up screen for
   `create` (keeping any redirect) and puts focus in the sign-in form's email field for `signIn`;
   anything else, including no answer, leaves the sign-in screen as it is. Swift's
   `IntroSession` answers exactly once and refuses `create` when it was not offered; the web's
   `introChoice` accepts nothing else. Cognito, `authStore`, the keychain logic and the forms are
   untouched.

3. **The web owns the words, Swift owns the pictures and the motion.** The web sends every string
   with each request, in the app's language, after the language's catalog has loaded (a Spanish
   launch built the request from the English fallback before that wait was added; the e2e spec
   caught it). Swift carries no user-facing strings, which is the same split as the native frame
   and the form sheet and keeps one catalog for both languages. The pictures are the brand's own:
   the greenhouse mark redrawn from `public/brand/icon.svg` and `icon-on-green.svg`, its two
   plants growing up from the threshold, and the empty-state art's 240 x 180 greenhouse frame
   around an SF Symbol. Titles use the system serif and body text SF Pro; the brand faces are web
   fonts and are not in the binary.

4. **When it shows.** The whole story once per install, until it has been answered or the person
   has signed in on this install (a `localStorage` mark, which iOS deletes with the app). After
   that every signed-out start (a launch, a sign-out) opens on the last page only. At most once
   per signed-out stretch. Not when the person already chose to sign in (a `?redirect=` link to
   sign-in, a just-confirmed email).

5. **Gated on the bridge's plugin header**, as ADR 0034's keychain is: `hasNativeIntro()` is true
   only on iOS when `Capacitor.PluginHeaders` lists `NativeIntro` with `present` and `dismiss`.
   The plugin's JavaScript is loaded with a dynamic import behind that check, so the website,
   Android and an older build never download it.

6. **iOS conventions.** Swipe, Next and tappable page dots; Skip at the top right goes to the last
   page; a selection tick on every page change and a light impact on a door; Dynamic Type at every
   size with the page scrolling when it no longer fits; VoiceOver headings, focus moved to the new
   page's title, the dots as one adjustable element, and the escape gesture; Reduce Motion; safe
   areas; iPad width. The intro is light, like the rest of the app: Info.plist pins
   `UIUserInterfaceStyle` to Light because the web pages have no dark theme, and iOS reports that
   pin through every trait, the screen's included (measured on the simulator with the system in
   dark mode). The intro carries a second palette (the launch screen's Forest) that takes effect
   only if the pin moves from Info.plist to the web view's window, which is a separate decision.

## Consequences

- A new install sees what the app is for before it sees a form, in its own language, without a
  web view in the way. The forms behind it are the same as on the website.
- The web view keeps running under the intro, so the sign-in screen is rendered (and its launch
  screen released) before the intro covers it; tapping "I already have an account" fades onto a
  form that is already there.
- Android keeps the web sign-in screen. A Compose counterpart would be a separate decision.
- The words live in the web's catalogs, so changing them is a web change, but they reach people
  only through store builds: the intro is in the binary, and the binary carries its own copy of
  the web bundle.
- Two more things App Review reads now come from the catalog: `tests/unit/config/nativeIntro.test.ts`
  and `tests/e2e/native-review-hygiene.spec.ts` check every word of the intro, in English and
  Spanish, for plans, prices, gifts, trials and purchases.
- `npm run mobile:validate` now holds the app-target plugins too: every Swift class with a
  `jsName` must be registered by `MainViewController`, built by the Xcode project and listed in
  `docs/mobile.md`, so a plugin that is written but never registered (the failure the web cannot
  see: the bridge never lists it, and the feature silently falls back) fails the gate.
- Not decided here, and left as questions: Sign in with Apple, passkeys in the app, and any new
  way to authenticate. The intro's last page is where they would go.
