import { test, expect, type Page } from '@playwright/test';
import { uiLogin } from './helpers';

/**
 * The iOS app's signed-out intro (ADR 0035), from the web's side, on a real
 * production build.
 *
 * A signed-out start in the app asks the NativeIntro plugin to show the
 * intro over the sign-in screen, and opens the screen the person chose. The
 * iOS shell is pretended as in native-stays-signed-in.spec.ts, with a
 * `PluginHeaders` entry for NativeIntro so the plugin's calls reach a
 * pretend bridge, which records every request and answers as the test says.
 * The fallback tests pretend the shell without that entry, which is an app
 * built before the plugin: the sign-in screen must behave exactly as today.
 */

test.skip(
  ({ browserName }) => browserName === 'firefox',
  'the shell under test is WebKit; Chromium checks the same code'
);
test.use({ viewport: { width: 402, height: 874 } });

type Answer = 'create' | 'signIn' | 'none';

interface IntroCall {
  method: string;
  options: {
    start?: string;
    pages?: Array<{ id: string; title: string; body: string }>;
    create?: string;
    signIn?: string;
    skip?: string;
    next?: string;
    tagline?: string;
    token?: string;
  };
}

async function pretendToBeTheIosShell(page: Page, opts: { intro: boolean; answer?: Answer }) {
  await page.addInitScript(
    ({ intro, answer }) => {
      const w = window as unknown as Record<string, unknown>;
      const calls: unknown[] = [];
      w.__introCalls = calls;
      w.CapacitorCustomPlatform = { name: 'ios', plugins: {} };
      w.Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => 'ios',
        PluginHeaders: intro
          ? [
              {
                name: 'NativeIntro',
                methods: [
                  { name: 'present', rtype: 'promise' },
                  { name: 'dismiss', rtype: 'promise' },
                ],
              },
            ]
          : [],
        nativePromise: (plugin: string, method: string, options: unknown) => {
          if (plugin === 'NativeIntro') calls.push({ method, options });
          if (plugin === 'NativeIntro' && method === 'present') {
            // A beat, as a person would take, then the door the test chose.
            return new Promise((resolve) =>
              setTimeout(() => resolve({ choice: answer === 'none' ? null : answer }), 50)
            );
          }
          return Promise.resolve();
        },
        nativeCallback: () => 'callback',
      };
    },
    { intro: opts.intro, answer: opts.answer ?? 'none' }
  );
}

/** The intro plugin's own chunk (services/nativeIntro.ts), by Vite's name for it. */
const INTRO_CHUNK = /\/assets\/nativeIntro-[\w-]+\.js$/;

function watchIntroChunk(page: Page): string[] {
  const loaded: string[] = [];
  page.on('request', (r) => {
    if (INTRO_CHUNK.test(new URL(r.url()).pathname)) loaded.push(r.url());
  });
  return loaded;
}

function introCalls(page: Page): Promise<IntroCall[]> {
  return page.evaluate(() => (window as unknown as { __introCalls: IntroCall[] }).__introCalls);
}

async function presented(page: Page): Promise<IntroCall[]> {
  await expect
    .poll(async () => (await introCalls(page)).filter((c) => c.method === 'present').length, {
      timeout: 15000,
    })
    .toBeGreaterThan(0);
  return (await introCalls(page)).filter((c) => c.method === 'present');
}

test.describe('inside the iOS app, with the intro', () => {
  test('a signed-out launch tells the story, and "Create account" opens sign-up', async ({
    page,
  }) => {
    await pretendToBeTheIosShell(page, { intro: true, answer: 'create' });
    const chunk = watchIntroChunk(page);
    await page.goto('/');
    const [call] = await presented(page);
    // The positive control for the fallback tests below: with the plugin
    // listed, its chunk is loaded.
    expect(chunk).toHaveLength(1);
    expect(call.options.start).toBe('story');
    expect(call.options.pages?.map((p) => p.id)).toEqual(['household', 'claim', 'away', 'start']);
    expect(call.options.pages?.[0].title).toBe('One plant list for the whole house');
    expect(call.options).toMatchObject({
      create: 'Create account',
      signIn: 'I already have an account',
      skip: 'Skip',
      next: 'Next',
    });
    await expect(page).toHaveURL(/\/register$/, { timeout: 15000 });
    await expect(page.getByRole('heading', { name: 'Start your greenhouse' })).toBeVisible();
    // Asked once.
    expect((await introCalls(page)).filter((c) => c.method === 'present')).toHaveLength(1);
  });

  test('"I already have an account" lands on sign-in with the email field focused; the next launch shows only the last page', async ({
    page,
  }) => {
    await pretendToBeTheIosShell(page, { intro: true, answer: 'signIn' });
    await page.goto('/');
    await presented(page);
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByLabel(/email/i)).toBeFocused({ timeout: 15000 });

    // Relaunch: the story was seen on this install.
    await page.reload();
    await expect
      .poll(async () => (await introCalls(page)).filter((c) => c.method === 'present').length, {
        timeout: 15000,
      })
      .toBe(1);
    const [again] = (await introCalls(page)).filter((c) => c.method === 'present');
    expect(again.options.start).toBe('final');
  });

  test('signing in works underneath, and a sign-out shows only the last page', async ({ page }) => {
    await pretendToBeTheIosShell(page, { intro: true, answer: 'signIn' });
    await page.goto('/');
    await presented(page);
    // The intro covers the form until it answers; then the form has focus.
    await expect(page.getByLabel(/email/i)).toBeFocused({ timeout: 15000 });
    await page.getByLabel(/email/i).fill('test@example.com');
    await page.getByLabel(/password/i).fill('password123');
    await page.getByRole('button', { name: /^sign in$/i }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15000 });
    // Sign out the way the drawer does (no native frame in this pretense).
    await page.getByRole('button', { name: /open sidebar/i }).click();
    await page.getByRole('button', { name: /^sign out$/i }).click();
    await expect(page).toHaveURL(/\/login$/, { timeout: 15000 });
    await expect
      .poll(
        async () =>
          (await introCalls(page))
            .filter((c) => c.method === 'present')
            .map((c) => c.options.start),
        { timeout: 15000 }
      )
      .toContain('final');
    const starts = (await introCalls(page))
      .filter((c) => c.method === 'present')
      .map((c) => c.options.start);
    // The launch's story (answered "I already have an account"), then the last page.
    expect(starts.at(-1)).toBe('final');
  });

  test('in Spanish, every word the intro shows is Spanish', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('i18nextLng', 'es'));
    await pretendToBeTheIosShell(page, { intro: true, answer: 'none' });
    await page.goto('/');
    const [call] = await presented(page);
    expect(call.options.pages?.map((p) => p.title)).toEqual([
      'Una lista de plantas para toda la casa',
      'Tómala y nadie riega dos veces',
      '¿Te vas unos días? Deja las plantas en buenas manos',
      'Empieza con tu hogar',
    ]);
    expect(call.options).toMatchObject({
      create: 'Crear una cuenta',
      signIn: 'Ya tengo una cuenta',
      skip: 'Omitir',
      next: 'Siguiente',
      tagline: 'Crecer juntos',
    });
    // Closed with no choice: the sign-in screen stays, in Spanish.
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('button', { name: 'Iniciar sesión' })).toBeVisible();
  });
});

test.describe('without the intro (unchanged)', () => {
  test('an app built without the plugin opens on the web sign-in screen, as before', async ({
    page,
  }) => {
    await pretendToBeTheIosShell(page, { intro: false });
    const chunk = watchIntroChunk(page);
    // The control: only the shells send a signed-out `/` to sign-in.
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/, { timeout: 15000 });
    await expect(page.getByRole('link', { name: /sign up free/i })).toBeVisible();
    // Signing in still works, and nothing ever asked for the intro.
    await uiLogin(page);
    expect(await introCalls(page)).toEqual([]);
    // The plugin's JavaScript is never loaded without its native half.
    expect(chunk).toEqual([]);
  });

  test('the website keeps its landing page and sign-in screen, and loads no plugin runtime', async ({
    page,
  }) => {
    // @capacitor/core is the runtime the intro's plugin module brings; the
    // website must never download it. Its bundle carries this name.
    const scripts: Promise<string>[] = [];
    page.on('response', (r) => {
      if (r.url().endsWith('.js')) scripts.push(r.text().catch(() => ''));
    });
    const chunk = watchIntroChunk(page);
    await page.goto('/');
    await expect(page).not.toHaveURL(/\/login$/);
    await page.goto('/login');
    await expect(page.getByRole('button', { name: /^sign in$/i })).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByRole('link', { name: /sign up free/i })).toBeVisible();
    const bodies = await Promise.all(scripts);
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.filter((b) => b.includes('CapacitorCustomPlatform'))).toEqual([]);
    expect(chunk).toEqual([]);
  });
});
