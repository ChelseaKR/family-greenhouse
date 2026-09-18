/**
 * Android back (the button, or the edge swipe) inside the shell.
 *
 * Before this, back was whatever `@capacitor/app` does with no listener: go
 * back in the WebView's history if it can, and otherwise do nothing at all.
 * So on the first screen back was dead: it neither left the app nor gave any
 * sign it had been pressed. It also ignored whatever was open on top of the
 * page, so back with the navigation drawer or a dialog open changed the page
 * underneath it and left the overlay up.
 *
 * Now, in order:
 *  1. A dialog, menu or listbox is open: close it, the way Escape does.
 *  2. There is in-app history: go back one entry.
 *  3. Otherwise: move the app to the background, which is what Android 12+
 *     does for a launcher activity at its root. The app keeps its place, and
 *     reopening it returns to the same screen.
 *
 * Predictive back. Android 13+ can preview where back leads (and 16 does by
 * default for apps targeting it, which this one does) only when the app is
 * not intercepting back. So the interception is switched off
 * (`App.toggleBackButtonHandler`) whenever step 3 is what would happen, and the
 * system shows its own back-to-home animation and handles the press itself.
 * It is switched on whenever there is an overlay to close or in-app history
 * to go back through. The listener still ends in step 3 in case that estimate
 * is ever wrong, so a stale toggle costs an animation, never a dead button.
 *
 * nativeBackButton.ts loads this module, and this module loads
 * `@capacitor/app`, only inside the Android shell, so web visitors download
 * neither. iOS has no back button; its edge swipe is WKWebView's own and is
 * not configured here.
 */

/** What Escape closes: Headless UI dialogs, menus and listboxes. */
export const OVERLAY_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

function topmostOverlay(): Element | null {
  const overlays = document.querySelectorAll(OVERLAY_SELECTOR);
  return overlays.length ? overlays[overlays.length - 1] : null;
}

/** Closes the topmost overlay the way a keyboard user would. False if none. */
export function closeTopmostOverlay(): boolean {
  const overlay = topmostOverlay();
  if (!overlay) return false;
  // Headless UI listens for Escape on the window, and only the topmost layer
  // acts on it. Dispatch from inside the overlay when focus is there, so a
  // listbox inside a dialog closes before the dialog does.
  const target =
    document.activeElement && overlay.contains(document.activeElement)
      ? document.activeElement
      : overlay;
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })
  );
  return true;
}

/**
 * Best estimate of "there is in-app history to go back through": React
 * Router numbers its entries (`history.state.idx`, 0 for the first one this
 * session). An entry without that number was pushed by someone else, such as
 * a Universal Link (nativeDeepLinks.ts), so it counts as having history.
 */
export function hasInAppHistory(): boolean {
  const state = window.history.state as { idx?: unknown } | null;
  return typeof state?.idx === 'number' ? state.idx > 0 : window.history.length > 1;
}

export function shouldInterceptBack(): boolean {
  return topmostOverlay() !== null || hasInAppHistory();
}

/** Registers the listener and keeps the interception toggle in step. */
export async function installNativeBackButton(): Promise<void> {
  const { App } = await import('@capacitor/app');

  await App.addListener('backButton', ({ canGoBack }) => {
    if (closeTopmostOverlay()) return;
    if (canGoBack) {
      window.history.back();
      return;
    }
    void App.minimizeApp();
  });

  let intercepting: boolean | null = null;
  let scheduled = false;
  const sync = () => {
    scheduled = false;
    const next = shouldInterceptBack();
    if (next === intercepting) return;
    intercepting = next;
    void App.toggleBackButtonHandler({ enabled: next }).catch(() => undefined);
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(sync);
  };

  // Every navigation and every overlay opening or closing changes the DOM,
  // so one observer covers both without hooking the router.
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('popstate', schedule);
  sync();
}
