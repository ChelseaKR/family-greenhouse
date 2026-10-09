# 0034 — The app stays signed in: the refresh token lives in the device keychain, for a year

**Status:** Accepted

**Date:** 2026-10-09

**Deciders:** Chelsea Kelly-Reif

**Related:** [security review 2026-05-31](../security-review-2026-05-31.md), finding 7.1 (the
refresh token moved off `localStorage`); [#763](https://github.com/ChelseaKR/family-greenhouse/pull/763)
("Keep me signed in", opt-in, on the website); [ADR 0013](0013-build-time-prerendering-of-public-routes.md);
`frontend/src/services/sessionVault.ts`, `frontend/src/store/authStore.ts`,
`frontend/src/services/api.ts`, `infrastructure/modules/auth/main.tf`.

## Context

The owner, on TestFlight build 4001 (2026-10-09): "users shouldn't have to keep on signing into
the app when they open it - authorize once, always remember."

The web app's session has three parts. The Cognito ID and access tokens last an hour and are kept
in `localStorage`, so a reload keeps the session. The refresh token lasts 30 days and, since
finding 7.1, is kept in `sessionStorage` unless the person ticks "Keep me signed in" (#763): a
browser drops `sessionStorage` when the tab closes, which caps what an XSS token theft can take at
about one access-token lifetime. That is the right default for a browser on a shared computer.

A WKWebView drops `sessionStorage` the same way, every time the app process ends: a force quit, a
reboot, or iOS reclaiming memory while the app is in the background. So inside the shells the
refresh token never survived a cold start. The next launch read a live ID token from
`localStorage` and was signed in only if less than an hour had passed; past that, `/auth/me`
answered 401, there was no refresh token to try, and `verifySession` ended the session on the
sign-in screen. With native push on (0.40.0), the registration sync at launch sent the expired ID
token too, and its 401 ended the session through the api interceptor, by the same path. Nobody
had ticked "Keep me signed in" on the phone; the checkbox is unticked by default, and on a phone it
is not a question. Established by reading the store, the interceptor and the Cognito client
configuration, and reproduced in Playwright with the shell pretended
(`tests/e2e/native-stays-signed-in.spec.ts`); not reproduced on the simulator.

Two more facts shape the fix. Cognito fixes a refresh token's expiry when it issues it and does
not extend it on use (`REFRESH_TOKEN_AUTH` returns no new refresh token), so the client's 30 days
is the longest any device goes between sign-ins, however often it is used. And the frontend's
All-JS-combined budget stood at 653 kB over a measured 651.64 kB, so a plugin costs a budget note.

## Decision

1. **Inside the shells, the refresh token goes to the device keychain, and nowhere else.** iOS
   keychain, Android Keystore (AES-GCM, key generated in and never exported from the Keystore),
   through `@aparajita/capacitor-secure-storage` 8.0.1, pinned exactly. It is a Capacitor 8 plugin
   released 2026-09-23, with a selectable keychain accessibility class and no iCloud sync unless
   asked. Considered and set aside: `capacitor-secure-storage-plugin` 0.13.0 (Capacitor 8, but the
   accessibility class is not selectable and the last release was January); `@capacitor/preferences`
   (UserDefaults and SharedPreferences, neither encrypted, both backed up: the wrong place for a
   credential); a plugin written here, as `NativeChrome` and `Print` are (the Swift side is a
   screen of code, the Android side is Keystore cryptography written by hand, and that is the part
   worth not owning). Measured cost: All JS combined 651.64 to 654.5 kB (+2.86 kB), Initial JS
   26.85 to 26.87 kB, Vendor and CSS unchanged; the budget moves from 653 to 674 kB, the usual 3%
   over the measured total (`frontend/package.json`, `_size-limit-note-stays-signed-in`).
2. **The item is `afterFirstUnlockThisDeviceOnly`.** Readable once the phone has been unlocked
   since it booted, so a launch from a notification works; never in a backup, so it cannot move to
   another device. iOS keeps an app's keychain items through a reinstall, so a launch that finds no
   session in `localStorage` drops any token the keychain still holds, rather than signing in
   with it: a reinstall is a fresh start.
3. **The rest of the session stays in `localStorage`, and the keychain is read before any
   verdict.** The user, the ID token and `isAuthenticated` are read synchronously at boot, so the
   first render already knows the person is signed in and shows the loading state, never the
   sign-in screen, while the keychain is read. `verifySession` reads the keychain once per launch
   before judging anything; the api interceptor and `refreshSession` wait for that same read
   before concluding there is no refresh token to try with, which is what closes the native-push
   path above.
4. **A known-expired ID token goes straight to the refresh.** The client reads the token's `exp`
   (`lib/jwtExpiry.ts`, no verification: the server keeps the last word) and skips the `/auth/me`
   call whose answer it already knows. That is one round trip fewer on the launches that matter
   most.
5. **Sign-out is the only way out, apart from the server refusing the token.** Sign-out removes
   the keychain item. A refused refresh, or a refused ID token with nothing to refresh with, is a
   full sign-out in the shells, where there are no other tabs to protect; the website keeps its
   tab-local clear. "We could not ask" still is not "the server said no": offline launches keep
   the session as before.
6. **The shells do not ask.** The sign-in screen's checkbox is replaced in the shells by one line,
   "This device stays signed in until you sign out." The website is unchanged: the checkbox,
   unticked by default, the `sessionStorage` default and the `localStorage` opt-in all stay. The
   website does not have this defect: closing the tab ends an unremembered session by design, and
   a reload keeps it.
7. **The Cognito client's refresh-token validity goes from 30 to 365 days.** A phone that is
   signed into once a year has been "authorized once" by any reasonable reading, and a year is
   the longest period after which asking again still reads as routine rather than as a fault. The
   maximum, 3650 days, is set aside because the validity is a property of the app client, and the
   client serves the website too: a person who ticks "Keep me signed in" in a browser gets the
   same year, in `localStorage`, under the XSS exposure finding 7.1 describes. A year bounds that
   exposure; ten would not, and the content security policy is the only other guard. The threat
   model on the phone: the keychain item is readable only by this app on this device, after the
   device's first unlock, with the lock screen in front of it; the item is in no backup; sign-out
   deletes the only copy. The number is a Terraform change the owner applies at release
   (`infrastructure/modules/auth/main.tf`); nothing in this ADR applies it.

## Consequences

- One more sign-in on the first launch of a build that carries this. A device signed in under an
  older build has its refresh token in the WebView's `sessionStorage`, which the update's process
  restart has already dropped; its keychain is empty until the next sign-in. After that one, it
  stays.
- Tokens issued before the Terraform apply keep the 30 days they were issued with. The first
  sign-in after the apply is the one that gets a year. Rolling the number back to 30 does not
  shorten a year-long token already issued; only revoking it does.
- Sign-out does not revoke the refresh token on the server. It deletes the only copy, which is
  what a sign-out could always do here; a year-long token makes server-side revocation
  (`RevokeToken`, which the re-authentication flow already uses) worth adding as `POST /auth/logout`.
  Not in this change.
- Two ways to tighten the year later, neither taken now: a second app client for the shells, so the
  website's opt-in sessions could stay at 30 days (the API's JWT authorizer would have to accept
  both client ids, and the backend would have to pick a client per request); and Cognito's refresh
  token rotation, which would make an active phone's session renew itself indefinitely (the
  backend echoes the old token today, and the website's "Keep me signed in" sessions share one
  token across tabs, which rotation would break without more work).
- The plugin declares `@capacitor/android`, `@capacitor/app`, `@capacitor/core`, `@capacitor/ios` and
  `@capacitor/keyboard` as dependencies rather than peer dependencies. They resolve to the copies
  already installed, so nothing is duplicated, but a Capacitor major bump has to carry this plugin
  with it.
- The old app build (4001 and earlier) keeps the old behavior until the next TestFlight build; the
  web deploy carries the code but it does nothing on the website. Rollback is a redeploy of the
  previous web build and the previous store build; no stored data changes shape.
