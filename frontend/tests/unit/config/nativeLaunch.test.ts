import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import config from '../../../capacitor.config';

/**
 * The native launch screen is held by configuration and released by code.
 *
 * `SplashScreen.launchAutoHide: false` means the OS launch screen stays up
 * until JavaScript calls `SplashScreen.hide()`. That is only safe while two
 * things stay wired: the route-ready signal that normally releases it
 * (`<NativeLaunchReady />` inside App's Suspense boundary), and the fallback
 * timer armed before any application module can throw (`nativeLaunchBoot`,
 * second import in main.tsx). Lose either and a store build can open onto a
 * splash that never goes away, which nothing short of a device would show.
 * These are file assertions: the behavior itself is covered by
 * tests/unit/services/nativeShell.test.ts.
 */

const root = resolve(__dirname, '../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

function importLines(source: string): string[] {
  return source.split('\n').filter((line) => /^import\s/.test(line));
}

describe('native launch screen wiring', () => {
  const splash = (config.plugins?.SplashScreen ?? {}) as { launchAutoHide?: boolean };

  it('holds the launch screen for JavaScript to release', () => {
    expect(splash.launchAutoHide).toBe(false);
  });

  it('arms the fallback before any other application module is evaluated', () => {
    const imports = importLines(read('src/main.tsx'));
    expect(imports[0]).toBe("import './telemetryBoot';");
    expect(imports[1]).toBe("import './nativeLaunchBoot';");
    expect(read('src/nativeLaunchBoot.ts')).toMatch(/^armNativeSplashFallback\(\);$/mu);
  });

  it('releases it from inside the route Suspense boundary, not on the loading fallback', () => {
    const app = read('src/App.tsx');
    const suspenseOpen = app.indexOf('<Suspense');
    const suspenseClose = app.indexOf('</Suspense>');
    const ready = app.indexOf('<NativeLaunchReady />');
    expect(ready).toBeGreaterThan(suspenseOpen);
    expect(ready).toBeLessThan(suspenseClose);
  });

  it('paints the WebView the launch screen color while the bundle loads', () => {
    // Otherwise the gap between launch screen and first paint is the
    // platform default: white, or black in dark mode.
    expect(config.backgroundColor?.toLowerCase()).toBe('#173404');
    expect(read('src/index.css')).toMatch(/html\s*{[^}]*background-color:\s*#173404/);
  });
});
