/**
 * Google Analytics 4 loader (services/googleAnalytics.ts): when it loads, what
 * it is told, and what page addresses it is given.
 *
 * "Loaded" is observable in exactly two places — the gtag.js <script> the
 * module injects and the `dataLayer` it pushes commands onto — so every test
 * reads both. Each negative case first asserts that its sabotage actually
 * landed (the signal is set, the shell is simulated), because a control that
 * silently no-ops reads exactly like a pass. The positive control runs the
 * same harness with nothing set and must load, which is what makes the
 * negatives mean anything.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ID = 'G-L2JN3PQ75P';
const GTAG_SCRIPT = 'script[src^="https://www.googletagmanager.com/gtag/js"]';

type Module = typeof import('./googleAnalytics');
type AnalyticsModule = typeof import('./analytics');

async function load(): Promise<{ ga: Module; analytics: AnalyticsModule }> {
  vi.resetModules();
  const analytics = await import('./analytics');
  const ga = await import('./googleAnalytics');
  return { ga, analytics };
}

function gtagScripts(): HTMLScriptElement[] {
  return [...document.querySelectorAll<HTMLScriptElement>(GTAG_SCRIPT)];
}

/** The dataLayer as plain arrays, so assertions can use toEqual. */
function commands(): unknown[][] {
  return (window.dataLayer ?? []).map((entry) => Array.from(entry as ArrayLike<unknown>));
}

function pageViews(): Array<Record<string, unknown>> {
  const all = commands();
  const views: Array<Record<string, unknown>> = [];
  all.forEach((command, index) => {
    if (command[0] === 'event' && command[1] === 'page_view') {
      const set = all[index - 1];
      expect(set?.[0], 'every page_view is preceded by the set that scrubs it').toBe('set');
      views.push(set?.[1] as Record<string, unknown>);
    }
  });
  return views;
}

function setGpc(value: unknown) {
  Object.defineProperty(globalThis.navigator, 'globalPrivacyControl', {
    value,
    configurable: true,
  });
}

function setDnt(value: string | null) {
  Object.defineProperty(globalThis.navigator, 'doNotTrack', { value, configurable: true });
}

function clearCookies() {
  for (const pair of document.cookie.split(';')) {
    const name = pair.split('=', 1)[0].trim();
    if (name) document.cookie = `${name}=; Max-Age=0; path=/`;
  }
}

beforeEach(() => {
  vi.stubEnv('VITE_GA_MEASUREMENT_ID', ID);
  setDnt(null);
  setGpc(undefined);
  localStorage.clear();
  delete (window as { Capacitor?: unknown }).Capacitor;
  delete window.dataLayer;
  for (const script of gtagScripts()) script.remove();
  delete (window as unknown as Record<string, unknown>)[`ga-disable-${ID}`];
  clearCookies();
});

afterEach(() => {
  vi.unstubAllEnvs();
  setDnt(null);
  setGpc(undefined);
  localStorage.clear();
  delete (window as { Capacitor?: unknown }).Capacitor;
  delete window.dataLayer;
  for (const script of gtagScripts()) script.remove();
  delete (window as unknown as Record<string, unknown>)[`ga-disable-${ID}`];
  clearCookies();
});

describe('when Google Analytics loads', () => {
  it('loads with a measurement ID, in a browser, with no opt-out (positive control)', async () => {
    const { ga, analytics } = await load();
    expect(analytics.analyticsOptedOut()).toBe(false);

    expect(ga.initGoogleAnalytics()).toBe(true);

    const scripts = gtagScripts();
    expect(scripts).toHaveLength(1);
    expect(scripts[0].src).toBe(`https://www.googletagmanager.com/gtag/js?id=${ID}`);
    expect(scripts[0].async).toBe(true);
    // gtag.js ignores anything that is not an `arguments` object.
    for (const entry of window.dataLayer ?? []) {
      expect(Object.prototype.toString.call(entry)).toBe('[object Arguments]');
    }
  });

  it('loads nothing without a measurement ID — every build but production web', async () => {
    vi.stubEnv('VITE_GA_MEASUREMENT_ID', '');
    const { ga } = await load();
    expect(ga.gaMeasurementId()).toBeNull();

    expect(ga.initGoogleAnalytics()).toBe(false);
    expect(gtagScripts()).toHaveLength(0);
    expect(window.dataLayer).toBeUndefined();
  });

  it.each([
    ['a Universal Analytics id', 'UA-12345-1'],
    ['a Tag Manager container id', 'GTM-ABC123'],
    ['markup', `${ID}"><script>`],
    ['lowercase', 'g-l2jn3pq75p'],
  ])('loads nothing for %s', async (_label, value) => {
    vi.stubEnv('VITE_GA_MEASUREMENT_ID', value);
    const { ga } = await load();
    expect(ga.initGoogleAnalytics()).toBe(false);
    expect(gtagScripts()).toHaveLength(0);
  });

  it('loads nothing under Global Privacy Control', async () => {
    setGpc(true);
    const { ga, analytics } = await load();
    // The sabotage landed: the browser declares GPC and the shim reads it.
    expect((navigator as Navigator & { globalPrivacyControl?: unknown }).globalPrivacyControl).toBe(
      true
    );
    expect(analytics.analyticsOptedOut()).toBe(true);

    expect(ga.initGoogleAnalytics()).toBe(false);
    expect(gtagScripts()).toHaveLength(0);
    expect(window.dataLayer).toBeUndefined();
  });

  it('loads nothing under Do Not Track', async () => {
    setDnt('1');
    const { ga, analytics } = await load();
    expect(navigator.doNotTrack).toBe('1');
    expect(analytics.analyticsOptedOut()).toBe(true);

    expect(ga.initGoogleAnalytics()).toBe(false);
    expect(gtagScripts()).toHaveLength(0);
  });

  it('loads nothing when the in-app analytics switch is off', async () => {
    const { ga, analytics } = await load();
    analytics.setAnalyticsOptOut(true);
    expect(localStorage.getItem(analytics.ANALYTICS_OPT_OUT_STORAGE_KEY)).toBe('1');
    expect(analytics.analyticsOptedOut()).toBe(true);

    expect(ga.initGoogleAnalytics()).toBe(false);
    expect(gtagScripts()).toHaveLength(0);
  });

  it('loads nothing inside the Capacitor shell, even with an ID and no opt-out', async () => {
    (window as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
    };
    const { ga, analytics } = await load();
    const { isNativeApp } = await import('@/lib/platform');
    expect(isNativeApp()).toBe(true);
    expect(analytics.analyticsOptedOut()).toBe(false);

    expect(ga.initGoogleAnalytics()).toBe(false);
    expect(gtagScripts()).toHaveLength(0);
    expect(window.dataLayer).toBeUndefined();
  });

  it('loads once, however many times it is asked', async () => {
    const { ga } = await load();
    expect(ga.initGoogleAnalytics()).toBe(true);
    expect(ga.initGoogleAnalytics()).toBe(true);
    expect(gtagScripts()).toHaveLength(1);
  });
});

describe('what Google Analytics is told', () => {
  it('denies ad storage everywhere and analytics storage in the EEA, UK and Switzerland', async () => {
    const { ga } = await load();
    ga.initGoogleAnalytics();
    const defaults = commands().filter((c) => c[0] === 'consent' && c[1] === 'default');
    expect(defaults).toHaveLength(2);

    const regional = defaults.find((c) => (c[2] as { region?: unknown }).region)?.[2];
    const global = defaults.find((c) => !(c[2] as { region?: unknown }).region)?.[2];
    expect(regional).toEqual({
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      analytics_storage: 'denied',
      region: ga.CONSENT_DENIED_REGIONS,
    });
    expect(global).toEqual({
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      analytics_storage: 'granted',
    });
    // Nothing ever grants ad consent later.
    expect(commands().filter((c) => c[0] === 'consent' && c[1] === 'update')).toEqual([]);
  });

  it('lists every EEA state, the UK and Switzerland, and not the US', async () => {
    const { ga } = await load();
    const eea = [
      ...['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE'],
      ...['IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'],
      ...['IS', 'LI', 'NO'],
    ];
    expect(eea).toHaveLength(30);
    for (const code of [...eea, 'GB', 'CH']) {
      expect(ga.CONSENT_DENIED_REGIONS, code).toContain(code);
    }
    expect(ga.CONSENT_DENIED_REGIONS).not.toContain('US');
  });

  it('switches off Google signals, ad personalization and the automatic page view', async () => {
    const { ga } = await load();
    ga.initGoogleAnalytics();
    const config = commands().filter((c) => c[0] === 'config');
    expect(config).toEqual([
      [
        'config',
        ID,
        {
          send_page_view: false,
          allow_google_signals: false,
          allow_ad_personalization_signals: false,
        },
      ],
    ]);
    expect(commands()).toContainEqual(['set', 'ads_data_redaction', true]);
    // Consent defaults precede the config, as Consent Mode requires.
    const order = commands().map((c) => c[0]);
    expect(order.lastIndexOf('consent')).toBeLessThan(order.indexOf('config'));
    // No identity of any kind is ever handed to GA.
    expect(JSON.stringify(commands())).not.toMatch(/user_id|client_id|household/);
  });
});

describe('page views', () => {
  it('sends one scrubbed page view per route, keeping only campaign tags', async () => {
    const { ga } = await load();
    ga.initGoogleAnalytics();
    const origin = window.location.origin;

    ga.trackGooglePageView(
      '/pricing',
      '?utm_source=newsletter&utm_campaign=fall&ref=FRIEND42&email=a%40b.co',
      'Pricing — Family Greenhouse'
    );
    ga.trackGooglePageView(
      '/plants/0b6f7c1e-1111-4222-8333-944445555666',
      '?space=kitchen',
      'Fern'
    );
    ga.trackGooglePageView('/sit/abc123', '', 'Plant-sitting — Family Greenhouse');
    ga.trackGooglePageView('/blog/how-to-water-plants-while-on-vacation', '', 'Vacation watering');

    expect(pageViews()).toEqual([
      {
        page_location: `${origin}/pricing?utm_source=newsletter&utm_campaign=fall`,
        page_title: 'Pricing — Family Greenhouse',
      },
      {
        page_location: `${origin}/plants/:id`,
        // PlantDetailPage titles itself with the plant's user-typed name.
        page_title: ga.GENERIC_PAGE_TITLE,
        page_referrer: `${origin}/pricing?utm_source=newsletter&utm_campaign=fall`,
      },
      {
        page_location: `${origin}/sit/:token`,
        page_title: ga.GENERIC_PAGE_TITLE,
        page_referrer: `${origin}/plants/:id`,
      },
      {
        page_location: `${origin}/blog/how-to-water-plants-while-on-vacation`,
        page_title: 'Vacation watering',
        page_referrer: `${origin}/sit/:token`,
      },
    ]);
    const sent = JSON.stringify(commands());
    for (const secret of ['FRIEND42', 'a%40b.co', 'kitchen', 'abc123', 'Fern', '0b6f7c1e']) {
      expect(sent, secret).not.toContain(secret);
    }
  });

  it('counts a repeated address once', async () => {
    const { ga } = await load();
    ga.initGoogleAnalytics();
    ga.trackGooglePageView('/care', '', 'Care');
    ga.trackGooglePageView('/care', '', 'Care');
    ga.trackGooglePageView('/care', '?ref=x', 'Care');
    expect(pageViews()).toHaveLength(1);
    ga.trackGooglePageView('/pricing', '', 'Pricing');
    ga.trackGooglePageView('/care', '', 'Care');
    expect(pageViews()).toHaveLength(3);
  });

  it('sends nothing when Google Analytics did not load', async () => {
    vi.stubEnv('VITE_GA_MEASUREMENT_ID', '');
    const { ga } = await load();
    expect(ga.initGoogleAnalytics()).toBe(false);
    ga.trackGooglePageView('/pricing', '', 'Pricing');
    expect(window.dataLayer).toBeUndefined();
  });

  it('stops at once when the visitor opts out mid-visit, and drops the cookies', async () => {
    const { ga, analytics } = await load();
    ga.initGoogleAnalytics();
    ga.trackGooglePageView('/pricing', '', 'Pricing');
    const killSwitch = () => (window as unknown as Record<string, unknown>)[`ga-disable-${ID}`];
    expect(killSwitch()).toBe(false);
    document.cookie = '_ga=GA1.1.123.456; path=/';
    expect(document.cookie).toContain('_ga=');

    analytics.setAnalyticsOptOut(true);
    ga.clearGoogleAnalyticsCookies();

    // gtag.js reads the kill switch before every hit, including its own.
    expect(killSwitch()).toBe(true);
    ga.trackGooglePageView('/care', '', 'Care');
    expect(pageViews()).toHaveLength(1);
    expect(document.cookie).not.toContain('_ga=');
  });

  it('treats a referrer from another site as its origin only', async () => {
    const { ga } = await load();
    const origin = 'https://familygreenhouse.net';
    expect(ga.gaReferrer('https://www.google.com/search?q=monstera+care', origin)).toBe(
      'https://www.google.com/'
    );
    expect(ga.gaReferrer(`${origin}/kiosk/Zm9vYmFyYmF6?x=1`, origin)).toBe(
      `${origin}/kiosk/:token`
    );
    expect(ga.gaReferrer('', origin)).toBe('');
    expect(ga.gaReferrer('not a url', origin)).toBe('');
  });
});

describe('gaPagePath', () => {
  it.each([
    ['/', '/'],
    ['/pricing', '/pricing'],
    ['/care/monstera', '/care/monstera'],
    ['/pet-safe/parlor-palm', '/pet-safe/parlor-palm'],
    ['/help/getting-started', '/help/getting-started'],
    [
      '/blog/merging-plant-collections-when-you-move-in-together',
      '/blog/merging-plant-collections-when-you-move-in-together',
    ],
    ['/join/ab12', '/join/:token'],
    ['/shared/Xy9', '/shared/:token'],
    ['/sit/tok/brief', '/sit/:token/brief'],
    ['/kiosk/k', '/kiosk/:token'],
    ['/tag/t', '/tag/:token'],
    ['/caretaker/c', '/caretaker/:token'],
    ['/plants/0b6f7c1e-1111-4222-8333-944445555666', '/plants/:id'],
    ['/blog/Not_A_Slug_0123456789abcdefXYZ', '/blog/:token'],
    ['/settings/billing?status=success#x', '/settings/billing'],
  ])('%s -> %s', async (input, expected) => {
    const { ga } = await load();
    expect(ga.gaPagePath(input)).toBe(expected);
  });
});

describe('clearGoogleAnalyticsCookies', () => {
  it('removes _ga and _ga_<container> and nothing else', async () => {
    const { ga } = await load();
    document.cookie = '_ga=GA1.1.123.456; path=/';
    document.cookie = `_ga_L2JN3PQ75P=GS2.1.s1$o1; path=/`;
    document.cookie = 'keep_me=1; path=/';
    document.cookie = '_gallery=1; path=/';
    // The sabotage landed: all four are there before the call.
    for (const name of ['_ga=', '_ga_L2JN3PQ75P=', 'keep_me=', '_gallery=']) {
      expect(document.cookie).toContain(name);
    }

    ga.clearGoogleAnalyticsCookies();

    expect(document.cookie).not.toMatch(/(?:^|;\s*)_ga=/);
    expect(document.cookie).not.toContain('_ga_L2JN3PQ75P=');
    expect(document.cookie).toContain('keep_me=1');
    expect(document.cookie).toContain('_gallery=1');
  });

  it('runs at boot under an opt-out, so an old identifier does not linger', async () => {
    document.cookie = '_ga=GA1.1.123.456; path=/';
    setGpc(true);
    const { ga } = await load();
    expect(document.cookie).toContain('_ga=');
    expect(ga.initGoogleAnalytics()).toBe(false);
    expect(document.cookie).not.toContain('_ga=');
  });
});

describe('conversion events', () => {
  const ORDER = '0123456789abcdef0123456789abcdef';

  function conversions(): unknown[][] {
    return commands().filter((command) => command[0] === 'event' && command[1] !== 'page_view');
  }

  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('sends each conversion with only its own fields and a scrubbed address', async () => {
    window.history.replaceState(
      null,
      '',
      '/settings/billing?status=success&plan=garden&interval=month&utm_source=ads'
    );
    const { ga } = await load();
    expect(ga.initGoogleAnalytics()).toBe(true);
    const page_location = `${window.location.origin}/settings/billing?utm_source=ads`;

    ga.trackGoogleConversion({ name: 'sign_up' });
    ga.trackGoogleConversion({ name: 'start_trial' });
    ga.trackGoogleConversion({ name: 'landing_cta_click', cta: 'hero_signup' });
    ga.trackGoogleConversion({
      name: 'purchase',
      transactionId: ORDER,
      plan: 'greenhouse',
      interval: 'year',
      value: 79.99,
    });
    ga.trackGoogleConversion({ name: 'purchase', transactionId: ORDER });

    expect(conversions()).toEqual([
      ['event', 'sign_up', { method: 'email', page_location }],
      ['event', 'start_trial', { trial_plan: 'garden', trial_days: 14, page_location }],
      ['event', 'landing_cta_click', { cta: 'hero_signup', page_location }],
      [
        'event',
        'purchase',
        {
          transaction_id: ORDER,
          page_location,
          currency: 'USD',
          value: 79.99,
          items: [{ item_id: 'greenhouse_year', price: 79.99, quantity: 1 }],
        },
      ],
      ['event', 'purchase', { transaction_id: ORDER, page_location }],
    ]);
    // gtag.js ignores anything that is not an `arguments` object.
    for (const entry of window.dataLayer ?? []) {
      expect(Object.prototype.toString.call(entry)).toBe('[object Arguments]');
    }
  });

  it('never passes a field through: extra fields a caller adds are not sent', async () => {
    const { ga } = await load();
    ga.initGoogleAnalytics();
    const loaded = {
      email: 'reader@example.org',
      fullName: 'Ada Lovelace',
      householdName: 'The Lovelace Home',
      notes: 'water the fern on Sundays',
      stripeSubscriptionId: 'sub_1ABC',
      checkoutSessionId: 'cs_live_abc',
    };

    ga.trackGoogleConversion({ name: 'sign_up', ...loaded } as never);
    ga.trackGoogleConversion({
      name: 'purchase',
      transactionId: ORDER,
      plan: 'garden',
      interval: 'month',
      value: 4.99,
      ...loaded,
    } as never);

    expect(conversions()).toHaveLength(2);
    const sent = JSON.stringify(commands());
    for (const value of Object.values(loaded)) expect(sent, value).not.toContain(value);
  });

  it.each([
    ['a Stripe id as the transaction id', { name: 'purchase', transactionId: 'cs_live_abc' }],
    ['an upper-case transaction id', { name: 'purchase', transactionId: ORDER.toUpperCase() }],
    ['a short transaction id', { name: 'purchase', transactionId: ORDER.slice(1) }],
    [
      'the free tier as a purchase',
      { name: 'purchase', transactionId: ORDER, plan: 'seedling', interval: 'month', value: 0 },
    ],
    [
      'an unknown cadence',
      { name: 'purchase', transactionId: ORDER, plan: 'garden', interval: 'week', value: 1 },
    ],
    [
      'a negative value',
      { name: 'purchase', transactionId: ORDER, plan: 'garden', interval: 'month', value: -1 },
    ],
    [
      'a value that is not a number',
      { name: 'purchase', transactionId: ORDER, plan: 'garden', interval: 'month', value: NaN },
    ],
    ['a plan with no cadence or value', { name: 'purchase', transactionId: ORDER, plan: 'garden' }],
    ['an unlisted control', { name: 'landing_cta_click', cta: 'reader@example.org' }],
    ['an unlisted event', { name: 'login' }],
  ])('drops %s whole', async (_label, conversion) => {
    const { ga } = await load();
    ga.initGoogleAnalytics();
    ga.trackGoogleConversion(conversion as never);
    expect(conversions()).toEqual([]);
  });

  it('sends nothing when Google Analytics did not load', async () => {
    vi.stubEnv('VITE_GA_MEASUREMENT_ID', '');
    const { ga } = await load();
    expect(ga.initGoogleAnalytics()).toBe(false);
    ga.trackGoogleConversion({ name: 'sign_up' });
    expect(window.dataLayer).toBeUndefined();
  });

  it('sends nothing under Global Privacy Control', async () => {
    setGpc(true);
    const { ga, analytics } = await load();
    expect(analytics.analyticsOptedOut()).toBe(true);
    ga.initGoogleAnalytics();
    ga.trackGoogleConversion({ name: 'sign_up' });
    expect(window.dataLayer).toBeUndefined();
  });

  it('stops at once when the visitor opts out mid-visit', async () => {
    const { ga, analytics } = await load();
    ga.initGoogleAnalytics();
    ga.trackGoogleConversion({ name: 'sign_up' });
    expect(conversions()).toHaveLength(1);

    analytics.setAnalyticsOptOut(true);
    ga.trackGoogleConversion({ name: 'purchase', transactionId: ORDER });
    expect(conversions()).toHaveLength(1);
  });

  it('names a purchase by the first 32 hex characters of a SHA-256, never the id', async () => {
    const { ga } = await load();
    const id = await ga.gaTransactionId('sub_1ABC');
    // SHA-256('sub_1ABC'), first 32 hex characters, from Python's hashlib.
    expect(id).toBe('0ceb6e6bd4fce375ec15be41ba4b794b');
    expect(id).toMatch(/^[0-9a-f]{32}$/u);
    expect(await ga.gaTransactionId('')).toBeNull();
  });
});
