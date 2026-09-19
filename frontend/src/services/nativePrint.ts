import { getNativePlatform } from '@/lib/platform';

/**
 * Print the page: the plant passport, plant tags, the sitter brief and the
 * caretaker report all print through this.
 *
 * In a browser that is `window.print()`. Inside the iOS app it did nothing:
 * WKWebView drops `window.print()` unless the app handles it, so all four
 * print buttons were dead there (found in the App Store review of 0.37.0).
 * In the iOS shell this opens the system print sheet instead, through the
 * app's own `Print` plugin (`ios/App/App/PrintPlugin.swift`). The sheet prints
 * the page with its print styles, like a browser does, and its share button
 * saves or sends it as a PDF when there is no printer.
 *
 * `@capacitor/core` is imported only after the platform check, like
 * nativeShare.ts, so web visitors never download it.
 *
 * Android is not covered: its WebView drops `window.print()` as well, and it
 * has no plugin for this yet, so the call there is still the browser one.
 */

interface PrintOptions {
  jobName: string;
  anchorX?: number;
  anchorY?: number;
  anchorWidth?: number;
  anchorHeight?: number;
}

interface PrintPlugin {
  print(options: PrintOptions): Promise<{ completed: boolean }>;
}

let iosPrint: PrintPlugin | undefined;

/**
 * Registers the plugin once, and hands it back wrapped in an object, never
 * bare: a Capacitor plugin is a Proxy that answers every property, `then`
 * included, so a promise resolved WITH it takes it for a thenable and calls
 * `Print.then()` on the native side. That rejects as "not implemented", the
 * promise never settles, and the button does nothing again (seen in the iPad
 * simulator before this was wrapped).
 */
async function loadIosPrint(): Promise<{ plugin: PrintPlugin }> {
  if (!iosPrint) {
    const { registerPlugin } = await import('@capacitor/core');
    iosPrint = registerPlugin<PrintPlugin>('Print');
  }
  return { plugin: iosPrint };
}

/**
 * Opens the print dialog for the current page. `anchor` is the button that
 * was tapped: on iPad the print sheet is a popover and points at it.
 */
export async function printPage(anchor?: Element | null): Promise<void> {
  if (getNativePlatform() === 'ios') {
    const box = anchor?.getBoundingClientRect();
    try {
      const { plugin } = await loadIosPrint();
      await plugin.print({
        jobName: document.title,
        ...(box && box.width > 0 && box.height > 0
          ? { anchorX: box.x, anchorY: box.y, anchorWidth: box.width, anchorHeight: box.height }
          : {}),
      });
      return;
    } catch {
      // The plugin is missing (a development build pointed at an older
      // shell) or the sheet could not open. The browser call is all that is
      // left to try; at worst it does nothing, as it did before.
    }
  }
  window.print();
}

/** Test seam: forget the registered plugin between tests. */
export function resetNativePrintForTests(): void {
  iosPrint = undefined;
}
