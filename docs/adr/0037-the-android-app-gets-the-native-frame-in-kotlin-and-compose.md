# 0037 — The Android app gets the native frame, in Kotlin and Jetpack Compose, behind the iOS plugin's interface

**Status:** Accepted

**Date:** 2026-10-12

**Deciders:** Chelsea Kelly-Reif

**Related:** [ADR 0034](0034-the-app-stays-signed-in.md) and
[ADR 0035](0035-the-ios-app-opens-signed-out-on-a-native-intro.md) (plugins gated on the
bridge's plugin headers); `docs/mobile.md`, "The native frame (iOS)" and "The native frame
(Android)"; `frontend/android/app/src/main/java/net/familygreenhouse/app/frame/`;
`frontend/src/lib/platform.ts`, `frontend/src/services/nativeBackButtonHandler.ts`.

## Context

The owner, 2026-10-12: "for all my ios apps, ensure the android apps have full parity ... ensure
fg is also fully native".

The iOS app's chrome is native through the `NativeChrome` app-target plugin: a tab bar, a
navigation bar, More and Settings as native lists, alerts, action sheets, the Add care task form
sheet, and a screen's own menus and search in the bar. The Android app had none of it: the web's
header, drawer and dialogs inside a WebView, and a Java `MainActivity` with no code of its own.

## Decision

The Android app implements the same `NativeChrome` plugin, with the same name, methods, payloads
and events, in Kotlin, and draws it with Material 3 in Jetpack Compose:

- The web layer does not fork. `hasNativeFrame()` accepts Android when the bridge lists the
  plugin, and everything that keys on it (the `native-frame:` utilities, `NativeFrameBridge`,
  `NativePresenter`, the Add care task sheet, the Plants bar tools) works unchanged. An Android
  build without the plugin keeps the web's version, as an iOS build without it does.
- The back stacks are decided by a line-for-line port of `NativeFrameModel.swift`
  (`NativeFrameModel.kt`), so a route opens in the same tab with the same way back on both
  platforms. The alert, form-sheet and bar-tool rules are ports too. They are plain Kotlin and run
  as JVM unit tests.
- Android-only decisions: back follows Material's bottom-navigation rule (down the tab's stack,
  then to Home, then out of the app with the system's predictive back); the web's back handler
  keeps closing an open web dialog first and leaves the rest to the frame; the WebView stays in
  one place between the bars instead of moving between screens; the colors are a static Material
  3 scheme from the brand palette, light only, not wallpaper colors.
- Compose and Kotlin are new to the Android project. They are confined to `app/`; the Capacitor
  plugins stay Java.

## Consequences

- The Android app carries Kotlin and the Compose runtime: the debug APK is larger, and the
  release build is not yet minified (`minifyEnabled false`), which is a separate decision.
- Kotlin is not compiled by the gate or by CI. The Swift has the same gap; the web's contract tests
  (`tests/unit/config/nativeFrame.test.ts`) read the Kotlin source to hold the field names, and the
  JVM tests run with `./gradlew testDebugUnitTest`.
- A change to the plugin's interface now has three sides to keep in step: the web, Swift and
  Kotlin. The contract tests fail on a method or field one side lacks.
- No store-visible change happens until an Android build is uploaded; there is no Android build
  in Play yet.
