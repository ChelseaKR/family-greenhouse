/**
 * Native-shell setup that runs before the app: the launch-screen fallback,
 * keeping the focused field in view when the keyboard opens, and the iOS
 * keyboard's Prev / Next / Done bar.
 *
 * **This must stay the second import in `main.tsx`, directly after
 * `telemetryBoot`.** `capacitor.config.ts` keeps the native launch screen up
 * until JavaScript releases it (services/nativeShell.ts). If that release
 * depended on application code, a top-level throw anywhere in the import
 * graph would leave the splash up for good, and a frozen launch screen looks
 * like a hung app rather than an error. ES modules evaluate each import's
 * body in order, so arming the timer here happens before any later module
 * body runs: whatever breaks after this line, the splash still comes down.
 *
 * Same reasoning as telemetryBoot.ts, one module later. Outside the shells
 * this does nothing.
 */
import {
  armNativeSplashFallback,
  initNativeKeyboardScroll,
  restoreKeyboardAccessoryBar,
} from './services/nativeShell';

armNativeSplashFallback();
// Not order-sensitive like the line above; they live here because this is the
// one native-shell entry point main.tsx already has.
initNativeKeyboardScroll();
restoreKeyboardAccessoryBar();
