import { isNativeApp } from '@/lib/platform';

/**
 * The OS share sheet for a link, inside the iOS/Android shells.
 *
 * Every link the app hands out (a household invite, a plant-sitter or
 * caretaker link, a cutting share, a referral link) was a "Copy link" button:
 * put it on the clipboard, then leave the app to paste it somewhere. In the
 * shells that button now opens the system share sheet, which sends it
 * straight to Messages, Mail, WhatsApp or anything else installed. Copy is
 * one of the sheet's own actions, so nothing is lost. The website keeps its
 * copy button: a desktop browser's share UI is not where people expect a
 * link to go, and the web behavior is not what this changes.
 *
 * `@capacitor/share` is imported dynamically after the isNativeApp() check,
 * like nativePush.ts, so web visitors never download it.
 */

export interface ShareLinkOptions {
  url: string;
  /** Android's chooser title; iOS ignores it. The button label reads well. */
  dialogTitle?: string;
}

/**
 * Opens the share sheet. Resolves true once it has been shown, whether the
 * person shared or dismissed it; false outside the shells, or if the sheet
 * could not open, so the caller falls back to copying.
 */
export async function shareLinkNatively({ url, dialogTitle }: ShareLinkOptions): Promise<boolean> {
  if (!isNativeApp()) return false;
  try {
    const { Share } = await import('@capacitor/share');
    if (!(await Share.canShare()).value) return false;
    await Share.share({ url, dialogTitle });
    return true;
  } catch (error) {
    // Both plugins reject when the person closes the sheet without choosing
    // anything. That is an answer, not a failure: don't copy behind their back.
    return /cancel/i.test(error instanceof Error ? error.message : String(error));
  }
}
