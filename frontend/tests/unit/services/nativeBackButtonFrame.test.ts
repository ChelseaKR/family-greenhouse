import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Android back inside the app WITH the native frame (NativeFrameController.kt
 * owns each tab's back stack). Its own file: every install of the handler
 * keeps a MutationObserver for the life of the module, so the frameless
 * installs in nativeBackButton.test.ts would answer the same DOM changes.
 */

type BackListener = (event: { canGoBack: boolean }) => void;

const listeners: BackListener[] = [];
const minimizeApp = vi.fn(() => Promise.resolve());
const toggleBackButtonHandler = vi.fn((_options: { enabled: boolean }) => Promise.resolve());
const addListener = vi.fn((_event: string, listener: BackListener) => {
  listeners.push(listener);
  return Promise.resolve({ remove: () => Promise.resolve() });
});

vi.mock('@capacitor/app', () => ({
  App: { addListener, minimizeApp, toggleBackButtonHandler },
}));

import { initNativeBackButton } from '@/services/nativeBackButton';

async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 20));
}

function openDialog(): HTMLElement {
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  document.body.appendChild(dialog);
  return dialog;
}

describe('Android back', () => {
  beforeAll(async () => {
    window.history.replaceState({ idx: 0 }, '');
    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
      // What the Android app's bridge lists when MainActivity registers the
      // native frame (NativeChromePlugin.kt).
      PluginHeaders: [
        { name: 'NativeChrome', methods: [{ name: 'configure' }, { name: 'update' }] },
      ],
    };
    initNativeBackButton();
    await settle();
  });

  afterAll(() => {
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  });

  beforeEach(() => {
    minimizeApp.mockClear();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('closes an open dialog first, as without the frame', () => {
    const dialog = openDialog();
    const escapes: string[] = [];
    window.addEventListener('keydown', (event) => escapes.push(event.key), { once: true });
    listeners[0]({ canGoBack: true });
    expect(escapes).toEqual(['Escape']);
    dialog.remove();
  });

  it('leaves the tab stacks to the frame: no history back, no minimize', () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    listeners[0]({ canGoBack: true });
    listeners[0]({ canGoBack: false });
    expect(back).not.toHaveBeenCalled();
    expect(minimizeApp).not.toHaveBeenCalled();
  });

  it('intercepts only while something is open on top of the page', async () => {
    toggleBackButtonHandler.mockClear();
    window.history.pushState({ idx: 1 }, '', '/plants');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await settle();
    // In-app history alone does not take the press from the frame.
    expect(toggleBackButtonHandler).not.toHaveBeenCalledWith({ enabled: true });

    openDialog();
    await settle();
    expect(toggleBackButtonHandler).toHaveBeenLastCalledWith({ enabled: true });

    document.body.innerHTML = '';
    await settle();
    expect(toggleBackButtonHandler).toHaveBeenLastCalledWith({ enabled: false });
  });
});
