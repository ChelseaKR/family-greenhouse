import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashEmail, reportAdConversion } from '../../../src/utils/adConversions.js';

describe('adConversions', () => {
  // Restore only the three keys this suite touches, individually, rather
  // than reassigning `process.env` wholesale — `pool: 'threads'` (see
  // vitest.config.ts) shares one Node process across every test file in
  // the run, and `process.env` is not reset per file, so replacing the
  // whole object here clobbered env vars other suites (e.g. the
  // integration login flow) depend on. Same targeted-restore pattern as
  // `tests/unit/utils/serverAnalytics.test.ts`.
  const originalGoogleAdsId = process.env.GOOGLE_ADS_CONVERSION_ID;
  const originalMetaPixelId = process.env.META_CAPI_PIXEL_ID;
  const originalMetaAccessToken = process.env.META_CAPI_ACCESS_TOKEN;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    delete process.env.GOOGLE_ADS_CONVERSION_ID;
    delete process.env.META_CAPI_PIXEL_ID;
    delete process.env.META_CAPI_ACCESS_TOKEN;
    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    if (originalGoogleAdsId === undefined) delete process.env.GOOGLE_ADS_CONVERSION_ID;
    else process.env.GOOGLE_ADS_CONVERSION_ID = originalGoogleAdsId;
    if (originalMetaPixelId === undefined) delete process.env.META_CAPI_PIXEL_ID;
    else process.env.META_CAPI_PIXEL_ID = originalMetaPixelId;
    if (originalMetaAccessToken === undefined) delete process.env.META_CAPI_ACCESS_TOKEN;
    else process.env.META_CAPI_ACCESS_TOKEN = originalMetaAccessToken;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('hashEmail', () => {
    it('is a deterministic SHA-256 hex digest of the lower-cased, trimmed email', () => {
      expect(hashEmail('  Sitter@Example.com ')).toBe(hashEmail('sitter@example.com'));
      expect(hashEmail('sitter@example.com')).toMatch(/^[0-9a-f]{64}$/);
    });

    it('never returns the raw email', () => {
      expect(hashEmail('sitter@example.com')).not.toContain('sitter');
      expect(hashEmail('sitter@example.com')).not.toContain('@');
    });
  });

  describe('reportAdConversion', () => {
    // Negative control: with no ad-platform credential configured (every
    // environment today), this must be a true no-op — no network call at
    // all, not merely a call that gets refused server-side.
    it('makes no network call when no ad platform is configured', async () => {
      await reportAdConversion('signup_completed', { hashedEmail: hashEmail('a@b.com') });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('never throws even when neither platform is configured and props are empty', async () => {
      await expect(reportAdConversion('subscription_paid')).resolves.toBeUndefined();
    });

    it('posts to the Meta Conversions API when META_CAPI_* is configured, hashed email only', async () => {
      process.env.META_CAPI_PIXEL_ID = 'test-pixel-id';
      process.env.META_CAPI_ACCESS_TOKEN = 'test-token';

      await reportAdConversion('subscription_paid', {
        plan: 'garden',
        valueUsd: 4.99,
        hashedEmail: hashEmail('sitter@example.com'),
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe(
        'https://graph.facebook.com/v21.0/test-pixel-id/events?access_token=test-token'
      );
      const body = JSON.parse(init.body);
      expect(body.data[0].event_name).toBe('Subscribe');
      expect(body.data[0].custom_data).toEqual({
        value: 4.99,
        currency: 'USD',
        content_name: 'garden',
      });
      expect(body.data[0].user_data.em).toEqual([hashEmail('sitter@example.com')]);
      // The raw email must never appear anywhere in the outgoing payload.
      expect(init.body).not.toContain('sitter@example.com');
    });

    it('maps signup_completed to CompleteRegistration', async () => {
      process.env.META_CAPI_PIXEL_ID = 'test-pixel-id';
      process.env.META_CAPI_ACCESS_TOKEN = 'test-token';

      await reportAdConversion('signup_completed', { hashedEmail: hashEmail('a@b.com') });

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.data[0].event_name).toBe('CompleteRegistration');
    });

    it('never throws to the caller when the Meta API call rejects', async () => {
      process.env.META_CAPI_PIXEL_ID = 'test-pixel-id';
      process.env.META_CAPI_ACCESS_TOKEN = 'test-token';
      fetchSpy.mockRejectedValue(new Error('network down'));

      await expect(reportAdConversion('subscription_paid')).resolves.toBeUndefined();
    });

    it('makes no network call for Google Ads (documented stub) even if GOOGLE_ADS_CONVERSION_ID is set', async () => {
      process.env.GOOGLE_ADS_CONVERSION_ID = 'test-conversion-id';

      await reportAdConversion('signup_completed', { hashedEmail: hashEmail('a@b.com') });

      // The stub logs a warning but must not attempt a real request against
      // an ID nobody has configured for a real ad account.
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
