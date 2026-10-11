import { registerPlugin } from '@capacitor/core';
import {
  NATIVE_INTRO_PLUGIN,
  type NativeIntroRequest,
  type NativeIntroResult,
} from '@/config/nativeIntro';

/**
 * The iOS app's NativeIntro plugin (ios/App/App/NativeIntroPlugin.swift),
 * registered once. Loaded with a dynamic import, and only behind
 * `hasNativeIntro()`, so the website never downloads it or `@capacitor/core`
 * through it. Never resolve a promise with the plugin itself: it is a proxy
 * that answers every property, `then` included (services/loadNativeChrome.ts).
 */
interface NativeIntroPlugin {
  present(options: NativeIntroRequest): Promise<NativeIntroResult>;
  dismiss(options: { token: string }): Promise<void>;
}

const NativeIntro = registerPlugin<NativeIntroPlugin>(NATIVE_INTRO_PLUGIN);

let counter = 0;

/**
 * Shows the intro and resolves what it answered. `onToken` receives its name
 * before it shows, so the caller can close it (`dismissIntro`) if the sign-in
 * screen goes away first. Null when the call failed (Swift refused the
 * request, or the bridge did not answer): the intro was never seen, and the
 * sign-in screen stays.
 */
export async function presentIntro(
  request: Omit<NativeIntroRequest, 'token'>,
  onToken: (token: string) => void
): Promise<NativeIntroResult | null> {
  counter += 1;
  const token = `intro-${counter}`;
  onToken(token);
  try {
    return await NativeIntro.present({ ...request, token });
  } catch {
    return null;
  }
}

export function dismissIntro(token: string): void {
  void NativeIntro.dismiss({ token }).catch(() => undefined);
}
