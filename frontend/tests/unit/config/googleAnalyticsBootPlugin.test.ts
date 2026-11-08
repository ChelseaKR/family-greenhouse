/**
 * The build plugin that puts src/googleAnalyticsBoot.ts in every page's
 * <head> (vite.googleAnalyticsBoot.ts): it adds the entry and the tag only in
 * a production web build that carries a measurement ID, and refuses to emit a
 * page quietly without the chunk it asked for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The `.ts` extension is load-bearing: an extensionless import resolves to the
// `.js` that `tsc -b` emits beside the source, the LAST build's module.
import {
  GA_BOOT_ENTRY_NAME,
  GA_BOOT_SOURCE,
  gaMeasurementIdFromEnv,
  googleAnalyticsBoot,
} from '../../../vite.googleAnalyticsBoot.ts';

const ID = 'G-L2JN3PQ75P';

type ConfigHook = (
  userConfig: Record<string, unknown>,
  env: { mode: string; command: string; isSsrBuild?: boolean }
) => { build?: { rollupOptions?: { input?: Record<string, string> } } } | null;
type HtmlHook = (html: string, ctx: { bundle?: Record<string, unknown> }) => string;

function hooks() {
  const plugin = googleAnalyticsBoot();
  const config = plugin.config as unknown as ConfigHook;
  const configResolved = plugin.configResolved as unknown as (config: unknown) => void;
  const transform = plugin.transformIndexHtml as { order: string; handler: HtmlHook };
  return { plugin, config, configResolved, transform };
}

/** index.html as Vite's own html plugin leaves it: the app's entry already in <head>. */
const HTML =
  '<!doctype html><html><head><title>x</title>\n' +
  '    <script type="module" crossorigin src="/assets/index-XyZ12345.js"></script>\n' +
  '  </head><body><div id="root"></div></body></html>';
const BOOT_TAG =
  '<script type="module" crossorigin fetchpriority="high" src="/assets/ga-boot-AbCdEf12.js"></script>';
const BUNDLE = {
  'assets/ga-boot-AbCdEf12.js': {
    type: 'chunk',
    isEntry: true,
    name: GA_BOOT_ENTRY_NAME,
    fileName: 'assets/ga-boot-AbCdEf12.js',
  },
  'assets/index-XyZ12345.js': {
    type: 'chunk',
    isEntry: true,
    name: 'index',
    fileName: 'assets/index-XyZ12345.js',
  },
};

beforeEach(() => {
  vi.stubEnv('VITE_GA_MEASUREMENT_ID', ID);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('gaMeasurementIdFromEnv', () => {
  it('accepts a GA4 id and nothing else, as the loader does', () => {
    expect(gaMeasurementIdFromEnv({ VITE_GA_MEASUREMENT_ID: ` ${ID} ` })).toBe(ID);
    expect(gaMeasurementIdFromEnv({ VITE_GA_MEASUREMENT_ID: 'UA-12345-6' })).toBeNull();
    expect(gaMeasurementIdFromEnv({ VITE_GA_MEASUREMENT_ID: '' })).toBeNull();
    expect(gaMeasurementIdFromEnv({})).toBeNull();
  });
});

describe('the plugin', () => {
  it('only applies to builds, and runs its html step after the bundle exists', () => {
    const { plugin, transform } = hooks();
    expect(plugin.apply).toBe('build');
    expect(transform.order).toBe('post');
  });

  it('adds the boot entry beside index.html in a web build with an id (positive control)', () => {
    const { config } = hooks();
    const result = config({ root: process.cwd() }, { mode: 'production', command: 'build' });
    const input = result?.build?.rollupOptions?.input;
    expect(input?.[GA_BOOT_ENTRY_NAME]).toBe(GA_BOOT_SOURCE);
    expect(input?.index).toMatch(/[\\/]index\.html$/);
    expect(GA_BOOT_SOURCE).toMatch(/[\\/]src[\\/]googleAnalyticsBoot\.ts$/);
  });

  it('adds nothing to the SSR pass', () => {
    const { config } = hooks();
    expect(config({}, { mode: 'production', command: 'build', isSsrBuild: true })).toBeNull();
  });

  it('adds nothing without an id — every build but production web', () => {
    vi.stubEnv('VITE_GA_MEASUREMENT_ID', '');
    const { config } = hooks();
    expect(config({}, { mode: 'production', command: 'build' })).toBeNull();
  });

  it('adds nothing for a malformed id', () => {
    vi.stubEnv('VITE_GA_MEASUREMENT_ID', 'not-an-id');
    const { config } = hooks();
    expect(config({}, { mode: 'production', command: 'build' })).toBeNull();
  });

  it('places the chunk in <head> BEFORE the app entry, as a high-priority module script', () => {
    const { config, configResolved, transform } = hooks();
    config({}, { mode: 'production', command: 'build' });
    configResolved({ base: '/' });
    const result = transform.handler(HTML, { bundle: BUNDLE });
    const boot = result.indexOf(BOOT_TAG);
    const entry = result.indexOf(
      '<script type="module" crossorigin src="/assets/index-XyZ12345.js">'
    );
    const head = result.indexOf('</head>');
    expect(boot, 'the boot tag is present once').toBeGreaterThan(-1);
    expect(result.lastIndexOf(BOOT_TAG)).toBe(boot);
    expect(entry).toBeGreaterThan(boot);
    expect(head).toBeGreaterThan(entry);
    // Nothing else changed.
    expect(result.replace(`${BOOT_TAG}\n    `, '')).toBe(HTML);
  });

  it('honours a non-root base', () => {
    const { config, configResolved, transform } = hooks();
    config({}, { mode: 'production', command: 'build' });
    configResolved({ base: '/app/' });
    expect(transform.handler(HTML, { bundle: BUNDLE })).toContain(
      'src="/app/assets/ga-boot-AbCdEf12.js"'
    );
  });

  it('falls back to the end of <head> when the entry is not there yet', () => {
    const { config, configResolved, transform } = hooks();
    config({}, { mode: 'production', command: 'build' });
    configResolved({ base: '/' });
    const bare = '<!doctype html><html><head><title>x</title></head><body></body></html>';
    const result = transform.handler(bare, { bundle: BUNDLE });
    expect(result).toBe(
      `<!doctype html><html><head><title>x</title>${BOOT_TAG}\n    </head><body></body></html>`
    );
  });

  it('fails the build when the page has no <head>', () => {
    const { config, configResolved, transform } = hooks();
    config({}, { mode: 'production', command: 'build' });
    configResolved({ base: '/' });
    expect(() => transform.handler('<html><body></body></html>', { bundle: BUNDLE })).toThrow(
      /<\/head>/
    );
  });

  it('leaves the page alone when it added no entry', () => {
    vi.stubEnv('VITE_GA_MEASUREMENT_ID', '');
    const { config, configResolved, transform } = hooks();
    config({}, { mode: 'production', command: 'build' });
    configResolved({ base: '/' });
    expect(transform.handler(HTML, { bundle: BUNDLE })).toBe(HTML);
  });

  it('fails the build rather than emit a page without the chunk it asked for', () => {
    const { config, configResolved, transform } = hooks();
    config({}, { mode: 'production', command: 'build' });
    configResolved({ base: '/' });
    const withoutBoot = Object.fromEntries(
      Object.entries(BUNDLE).filter(([file]) => !file.includes('ga-boot'))
    );
    expect(Object.keys(withoutBoot)).toHaveLength(1);
    expect(() => transform.handler(HTML, { bundle: withoutBoot })).toThrow(/ga-boot/);
  });
});
