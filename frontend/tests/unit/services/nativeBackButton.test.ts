import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { closeTopmostOverlay, hasInAppHistory } from '@/services/nativeBackButtonHandler';

function enterShell(platform: 'android' | 'ios') {
  (window as unknown as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => platform,
  };
}

async function settle() {
  // Dynamic import, listener registration, then a requestAnimationFrame hop.
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 20));
}

function openDialog(): HTMLElement {
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  document.body.appendChild(dialog);
  return dialog;
}

describe('Android back', () => {
  beforeEach(() => {
    listeners.length = 0;
    addListener.mockClear();
    minimizeApp.mockClear();
    toggleBackButtonHandler.mockClear();
    window.history.replaceState({ idx: 0 }, '');
  });

  afterEach(() => {
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('does nothing on the website or on iOS', async () => {
    initNativeBackButton();
    enterShell('ios');
    initNativeBackButton();
    await settle();
    expect(addListener).not.toHaveBeenCalled();
    expect(toggleBackButtonHandler).not.toHaveBeenCalled();
  });

  describe('inside the Android shell', () => {
    beforeEach(async () => {
      enterShell('android');
      initNativeBackButton();
      await settle();
    });

    it('closes an open dialog instead of changing the page under it', () => {
      const dialog = openDialog();
      const escapes: string[] = [];
      window.addEventListener('keydown', (event) => escapes.push(event.key), { once: true });
      const back = vi.spyOn(window.history, 'back');

      listeners[0]({ canGoBack: true });

      expect(escapes).toEqual(['Escape']);
      expect(back).not.toHaveBeenCalled();
      expect(minimizeApp).not.toHaveBeenCalled();
      dialog.remove();
    });

    it('goes back one entry when there is in-app history', () => {
      const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
      listeners[0]({ canGoBack: true });
      expect(back).toHaveBeenCalledTimes(1);
      expect(minimizeApp).not.toHaveBeenCalled();
    });

    it('leaves the app from the first screen instead of doing nothing', () => {
      const back = vi.spyOn(window.history, 'back');
      listeners[0]({ canGoBack: false });
      expect(minimizeApp).toHaveBeenCalledTimes(1);
      expect(back).not.toHaveBeenCalled();
    });

    it('hands back to the system at the root, so Android can show predictive back', async () => {
      expect(toggleBackButtonHandler).toHaveBeenLastCalledWith({ enabled: false });

      openDialog();
      await settle();
      expect(toggleBackButtonHandler).toHaveBeenLastCalledWith({ enabled: true });

      document.body.innerHTML = '';
      await settle();
      expect(toggleBackButtonHandler).toHaveBeenLastCalledWith({ enabled: false });

      window.history.pushState({ idx: 1 }, '', '/plants');
      window.dispatchEvent(new PopStateEvent('popstate'));
      await settle();
      expect(toggleBackButtonHandler).toHaveBeenLastCalledWith({ enabled: true });
    });
  });
});

describe('hasInAppHistory', () => {
  it("reads React Router's entry number", () => {
    window.history.replaceState({ idx: 0 }, '');
    expect(hasInAppHistory()).toBe(false);
    window.history.replaceState({ idx: 3 }, '');
    expect(hasInAppHistory()).toBe(true);
  });

  it('treats an entry React Router did not number as having history', () => {
    // Universal Links push their own entry (nativeDeepLinks.ts) with no idx.
    window.history.replaceState(null, '');
    window.history.pushState(null, '', '/tasks');
    expect(hasInAppHistory()).toBe(true);
  });
});

describe('closeTopmostOverlay', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('reports false when nothing is open', () => {
    expect(closeTopmostOverlay()).toBe(false);
  });

  it('dispatches Escape from the focused element inside the overlay', () => {
    const dialog = openDialog();
    const input = document.createElement('input');
    dialog.appendChild(input);
    input.focus();
    const seen: EventTarget[] = [];
    window.addEventListener('keydown', (event) => seen.push(event.target!), { once: true });

    expect(closeTopmostOverlay()).toBe(true);
    expect(seen).toEqual([input]);
  });
});
