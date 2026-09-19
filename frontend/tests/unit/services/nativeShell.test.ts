import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hide = vi.fn(() => Promise.resolve());
const setStyle = vi.fn((_options: { style: string }) => Promise.resolve());
const setAccessoryBarVisible = vi.fn((_options: { isVisible: boolean }) => Promise.resolve());

vi.mock('@capacitor/splash-screen', () => ({ SplashScreen: { hide } }));
vi.mock('@capacitor/keyboard', () => ({ Keyboard: { setAccessoryBarVisible } }));
vi.mock('@capacitor/core', () => ({
  SystemBars: { setStyle },
  SystemBarsStyle: { Dark: 'DARK', Light: 'LIGHT', Default: 'DEFAULT' },
}));

import {
  SPLASH_FALLBACK_MS,
  armNativeSplashFallback,
  initNativeKeyboardScroll,
  markNativeAppReady,
  resetNativeShellForTests,
  restoreKeyboardAccessoryBar,
  setNativeStatusBarOverDarkSurface,
} from '@/services/nativeShell';

function enterNativeShell() {
  (window as unknown as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'ios',
  };
}

/** Let the two requestAnimationFrame hops and the dynamic imports settle. */
async function flush() {
  await vi.advanceTimersByTimeAsync(100);
}

/** A rendered page: the heading the launch screen waits for. */
function renderPage(title = 'Welcome back') {
  const main = document.createElement('div');
  main.id = 'main-content';
  main.innerHTML = `<h1>${title}</h1>`;
  document.body.appendChild(main);
}

describe('nativeShell', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hide.mockClear();
    setStyle.mockClear();
    resetNativeShellForTests();
  });

  afterEach(() => {
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('on the website', () => {
    it('never touches the splash or the status bar', async () => {
      armNativeSplashFallback();
      markNativeAppReady();
      setNativeStatusBarOverDarkSurface(true);
      await vi.advanceTimersByTimeAsync(SPLASH_FALLBACK_MS + 100);
      expect(hide).not.toHaveBeenCalled();
      expect(setStyle).not.toHaveBeenCalled();
    });
  });

  describe('inside the native shells', () => {
    beforeEach(enterNativeShell);

    it('releases the launch screen once the first route has rendered, dark icons first', async () => {
      renderPage();
      markNativeAppReady();
      await flush();

      expect(hide).toHaveBeenCalledTimes(1);
      expect(hide).toHaveBeenCalledWith({ fadeOutDuration: 200 });
      // The app is light, so the bar switches to dark content, and it does so
      // before the fade starts rather than after it.
      expect(setStyle).toHaveBeenCalledWith({ style: 'LIGHT' });
      expect(setStyle.mock.invocationCallOrder[0]).toBeLessThan(hide.mock.invocationCallOrder[0]);
    });

    it('releases it once, however many routes report ready', async () => {
      renderPage();
      markNativeAppReady();
      markNativeAppReady();
      await flush();
      markNativeAppReady();
      await flush();
      expect(hide).toHaveBeenCalledTimes(1);
    });

    it('releases it anyway when no route ever reports ready', async () => {
      // The failure this exists for: a startup error leaves nothing to call
      // markNativeAppReady, and a held splash would read as a hung app. Same
      // for a first screen with no heading: the wait for one is bounded too.
      armNativeSplashFallback();
      markNativeAppReady();
      await vi.advanceTimersByTimeAsync(SPLASH_FALLBACK_MS - 1);
      expect(hide).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await flush();
      expect(hide).toHaveBeenCalledTimes(1);
    });

    it('waits past a redirect that renders nothing for the page it lands on', async () => {
      // A signed-in `/` commits HomeRedirect first, which renders nothing and
      // navigates to /dashboard while that chunk loads. Releasing on that
      // commit faded the splash into a blank page.
      markNativeAppReady();
      await flush();
      expect(hide).not.toHaveBeenCalled();

      renderPage('Welcome back, Dana');
      await flush();
      expect(hide).toHaveBeenCalledTimes(1);
    });

    it('does not release it a second time after a normal start', async () => {
      renderPage();
      armNativeSplashFallback();
      markNativeAppReady();
      await flush();
      await vi.advanceTimersByTimeAsync(SPLASH_FALLBACK_MS + 100);
      expect(hide).toHaveBeenCalledTimes(1);
    });

    it('swallows a plugin failure instead of throwing into the app', async () => {
      hide.mockImplementationOnce(() => Promise.reject(new Error('not implemented')));
      renderPage();
      markNativeAppReady();
      await flush();
      expect(hide).toHaveBeenCalledTimes(1);
    });

    it('flips the status bar for the drawer when the page draws under it', async () => {
      const real = window.getComputedStyle.bind(window);
      vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
        const style = real(element);
        return { ...style, paddingTop: '47px' } as CSSStyleDeclaration;
      });

      setNativeStatusBarOverDarkSurface(true);
      await flush();
      expect(setStyle).toHaveBeenLastCalledWith({ style: 'DARK' });

      setNativeStatusBarOverDarkSurface(false);
      await flush();
      expect(setStyle).toHaveBeenLastCalledWith({ style: 'LIGHT' });
    });

    it('leaves the status bar alone when the WebView sits below it', async () => {
      // Android WebViews older than 140: Capacitor pads the WebView inside the
      // system bars, env(safe-area-inset-top) is 0, and the bar sits on the
      // light window background, not on the drawer.
      setNativeStatusBarOverDarkSurface(true);
      await flush();
      expect(setStyle).not.toHaveBeenCalled();
    });
  });
});

describe('keyboard', () => {
  let height = 874;
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    enterNativeShell();
    height = 874;
    Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => height });
    Element.prototype.scrollIntoView = scrollIntoView;
    scrollIntoView.mockClear();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 0;
    });
  });

  afterEach(() => {
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  function focusField(): HTMLTextAreaElement {
    const notes = document.createElement('textarea');
    document.body.appendChild(notes);
    notes.focus();
    return notes;
  }

  it('brings the focused field back into view when the keyboard shrinks the WebView', () => {
    initNativeKeyboardScroll();
    const notes = focusField();

    height = 539;
    window.dispatchEvent(new Event('resize'));

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(notes);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', inline: 'nearest' });
  });

  it('leaves the page alone when the keyboard closes or nothing is focused', () => {
    initNativeKeyboardScroll();

    height = 539;
    window.dispatchEvent(new Event('resize'));
    expect(scrollIntoView).not.toHaveBeenCalled();

    focusField();
    height = 874;
    window.dispatchEvent(new Event('resize'));
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

describe('keyboard accessory bar', () => {
  beforeEach(() => setAccessoryBarVisible.mockClear());
  afterEach(() => {
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  });

  it('turns the iOS Prev / Next / Done bar back on, which the keyboard plugin hides on load', async () => {
    enterNativeShell();
    restoreKeyboardAccessoryBar();
    await vi.waitFor(() =>
      expect(setAccessoryBarVisible).toHaveBeenCalledWith({ isVisible: true })
    );
  });

  it('never touches the plugin on Android or on the website', async () => {
    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
    };
    restoreKeyboardAccessoryBar();
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
    restoreKeyboardAccessoryBar();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(setAccessoryBarVisible).not.toHaveBeenCalled();
  });
});
