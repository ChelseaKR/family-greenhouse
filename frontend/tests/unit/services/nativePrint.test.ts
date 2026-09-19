import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const print = vi.fn<(options: Record<string, unknown>) => Promise<{ completed: boolean }>>(() =>
  Promise.resolve({ completed: true })
);
// Like Capacitor's own: a Proxy that answers EVERY property with a method,
// `then` included, and rejects for any method the plugin does not have. A
// plain `{ print }` object here once hid a real bug: resolving a promise with
// the proxy made it look like a thenable, and printing hung in the app.
const registerPlugin = vi.fn(
  (name: string) =>
    new Proxy({} as { print: typeof print }, {
      get: (_target, prop) =>
        prop === 'print'
          ? print
          : () =>
              Promise.reject(new Error(`"${name}.${String(prop)}()" is not implemented on ios`)),
    })
);

vi.mock('@capacitor/core', () => ({ registerPlugin }));

import { printPage, resetNativePrintForTests } from '@/services/nativePrint';

function setPlatform(platform: 'ios' | 'android') {
  (window as unknown as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => platform,
  };
}

describe('printPage', () => {
  let browserPrint: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    print.mockClear();
    registerPlugin.mockClear();
    resetNativePrintForTests();
    browserPrint = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    document.title = 'Plant passport: Monstera';
  });

  afterEach(() => {
    browserPrint.mockRestore();
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  });

  it('uses the browser print dialog on the website', async () => {
    await printPage();
    expect(browserPrint).toHaveBeenCalledTimes(1);
    expect(registerPlugin).not.toHaveBeenCalled();
  });

  it('opens the iOS print sheet in the iOS app, not window.print, which WKWebView drops', async () => {
    setPlatform('ios');
    await printPage();
    expect(registerPlugin).toHaveBeenCalledWith('Print');
    expect(print).toHaveBeenCalledWith({ jobName: 'Plant passport: Monstera' });
    expect(browserPrint).not.toHaveBeenCalled();
  });

  it('points the iPad popover at the button that was tapped', async () => {
    setPlatform('ios');
    const button = document.createElement('button');
    button.getBoundingClientRect = () => new DOMRect(40, 300, 160, 44);
    await printPage(button);
    expect(print).toHaveBeenCalledWith({
      jobName: 'Plant passport: Monstera',
      anchorX: 40,
      anchorY: 300,
      anchorWidth: 160,
      anchorHeight: 44,
    });
  });

  it('registers the plugin once however many times it prints', async () => {
    setPlatform('ios');
    await printPage();
    await printPage();
    expect(registerPlugin).toHaveBeenCalledTimes(1);
    expect(print).toHaveBeenCalledTimes(2);
  });

  it('treats a closed sheet as done, not as a reason to call window.print', async () => {
    setPlatform('ios');
    print.mockImplementationOnce(() => Promise.resolve({ completed: false }));
    await printPage();
    expect(browserPrint).not.toHaveBeenCalled();
  });

  it('falls back to the browser call when the plugin is missing', async () => {
    setPlatform('ios');
    print.mockImplementationOnce(() =>
      Promise.reject(new Error('"Print" plugin is not implemented on ios'))
    );
    await printPage();
    expect(browserPrint).toHaveBeenCalledTimes(1);
  });

  it('leaves Android on the browser call, which has no plugin yet', async () => {
    setPlatform('android');
    await printPage();
    expect(registerPlugin).not.toHaveBeenCalled();
    expect(browserPrint).toHaveBeenCalledTimes(1);
  });
});
