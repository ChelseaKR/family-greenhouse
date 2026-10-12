import { NativeChrome } from '@/services/nativeChrome';
import { nextPresentToken } from '@/services/nativePresent';
import type { NativeFormSheetRequest, NativeFormSheetResult } from '@/config/nativeFormSheet';

/**
 * Shows a web form as a native sheet in the iOS app and resolves what it
 * answered (config/nativeFormSheet.ts). Only ever loaded inside the app,
 * behind `hasNativeFormSheet()`. `onToken` receives the sheet's name before
 * it shows, so the caller can close it (`dismissFormSheet`) if the form goes
 * away first. A failed call answers no values: it never submits.
 */
export async function presentFormSheet(
  request: Omit<NativeFormSheetRequest, 'token'>,
  onToken: (token: string) => void
): Promise<NativeFormSheetResult> {
  const token = nextPresentToken();
  onToken(token);
  try {
    return await NativeChrome.presentForm({ ...request, token });
  } catch {
    return { values: null };
  }
}

export function dismissFormSheet(token: string): void {
  void NativeChrome.dismissPresented({ token }).catch(() => undefined);
}
