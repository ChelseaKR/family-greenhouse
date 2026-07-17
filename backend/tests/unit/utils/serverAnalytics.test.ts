import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

describe('serverAnalytics.capture', () => {
  const originalKey = process.env.POSTHOG_KEY;
  const originalHost = process.env.POSTHOG_HOST;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalKey === undefined) delete process.env.POSTHOG_KEY;
    else process.env.POSTHOG_KEY = originalKey;
    if (originalHost === undefined) delete process.env.POSTHOG_HOST;
    else process.env.POSTHOG_HOST = originalHost;
  });

  it('records first-party analytics but does not fetch when POSTHOG_KEY is unset', async () => {
    delete process.env.POSTHOG_KEY;
    const { capture } = await import('../../../src/utils/serverAnalytics.js');
    const { logger } = await import('../../../src/utils/logger.js');
    const logSpy = vi.spyOn(logger, 'info');
    await capture('hh-1', 'subscription_activated', { plan: 'garden', interval: 'year' });
    expect(logSpy).toHaveBeenCalledWith(
      {
        msg: 'product_event',
        productEvent: 'subscription_activated',
        properties: { plan: 'garden', interval: 'year' },
        householdId: 'hh-1',
        source: 'stripe_webhook',
      },
      'product_event'
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('no-ops when householdId is empty even with a key set', async () => {
    process.env.POSTHOG_KEY = 'phc_test';
    const { capture } = await import('../../../src/utils/serverAnalytics.js');
    await capture('', 'subscription_activated', { plan: 'garden' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs a household-scoped capture payload when the key is set', async () => {
    process.env.POSTHOG_KEY = 'phc_test';
    delete process.env.POSTHOG_HOST;
    const { capture } = await import('../../../src/utils/serverAnalytics.js');
    await capture('hh-1', 'subscription_activated', { plan: 'garden', interval: 'year' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://us.i.posthog.com/capture/');
    const body = JSON.parse((init as { body: string }).body);
    expect(body.api_key).toBe('phc_test');
    expect(body.event).toBe('subscription_activated');
    expect(body.distinct_id).toBe('household:hh-1');
    expect(body.properties.plan).toBe('garden');
    expect(body.properties.interval).toBe('year');
    expect(body.properties.$groups).toEqual({ household: 'hh-1' });
  });

  it('honors POSTHOG_HOST override', async () => {
    process.env.POSTHOG_KEY = 'phc_test';
    process.env.POSTHOG_HOST = 'https://eu.posthog.test';
    const { capture } = await import('../../../src/utils/serverAnalytics.js');
    await capture('hh-1', 'subscription_activated');
    expect(fetchSpy.mock.calls[0][0]).toBe('https://eu.posthog.test/capture/');
  });

  it('never rejects when fetch throws (analytics must not break billing)', async () => {
    process.env.POSTHOG_KEY = 'phc_test';
    fetchSpy.mockRejectedValue(new Error('network down'));
    const { capture } = await import('../../../src/utils/serverAnalytics.js');
    await expect(
      capture('hh-1', 'subscription_activated', { plan: 'garden' })
    ).resolves.toBeUndefined();
  });
});
