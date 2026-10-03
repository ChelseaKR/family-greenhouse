import { NativeChrome } from '@/services/nativeChrome';
import { chosenAction, menuRequest, type NativePresentAnchor } from '@/config/nativePresent';

/**
 * Helpers for Apple's alerts and action sheets in the iOS app (NativeChrome
 * `present`; components/native/NativePresenter.tsx shows the dialogs). Only
 * ever loaded inside the app, behind `hasNativePresent()`.
 */

let sequence = 0;
/** A name for one presentation, for `updatePresented` and `dismissPresented`. */
export function nextPresentToken(): string {
  sequence += 1;
  return `present-${Date.now().toString(36)}-${sequence}`;
}

function anchorOf(element: Element | null | undefined): NativePresentAnchor | undefined {
  const rect = element?.getBoundingClientRect();
  return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : undefined;
}

/**
 * The control last pressed, so an action sheet opened by it can point at it
 * on iPad (a popover). WebKit does not focus a tapped button, so focus can't
 * say which one it was.
 */
let lastPress: { target: Element; at: number } | null = null;
if (typeof document !== 'undefined') {
  document.addEventListener(
    'pointerdown',
    (event) => {
      const target =
        event.target instanceof Element ? event.target.closest('button, a, summary') : null;
      lastPress = target ? { target, at: Date.now() } : null;
    },
    { capture: true, passive: true }
  );
}

export function recentAnchor(): NativePresentAnchor | undefined {
  if (!lastPress || Date.now() - lastPress.at > 2000 || !lastPress.target.isConnected)
    return undefined;
  return anchorOf(lastPress.target);
}

/**
 * A menu as an action sheet (popover at `from` on iPad). Resolves the chosen
 * option's id, or null for Cancel or any other way of closing it.
 */
export async function chooseFromMenu(input: {
  title?: string;
  options: ReadonlyArray<{ id: string; title: string }>;
  cancel: string;
  from?: Element | null;
}): Promise<string | null> {
  const request = menuRequest(input);
  try {
    const result = await NativeChrome.present({
      ...request,
      token: nextPresentToken(),
      anchor: anchorOf(input.from),
    });
    return chosenAction(request, result);
  } catch {
    return null;
  }
}
