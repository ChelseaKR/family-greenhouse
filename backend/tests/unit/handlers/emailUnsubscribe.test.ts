import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'aws-lambda';

vi.mock('../../../src/services/email/capability.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/email/capability.js')>();
  return { ...actual, verifyUnsubscribeToken: vi.fn() };
});
vi.mock('../../../src/services/notificationPrefs.js', () => ({
  getPreferences: vi.fn(),
  setPreferences: vi.fn(),
  isValidTimeZone: vi.fn(() => true),
  disableEmailCategory: vi.fn(),
  startPhoneVerification: vi.fn(),
  confirmPhoneVerification: vi.fn(),
}));

const capability = await import('../../../src/services/email/capability.js');
const notificationPrefs = await import('../../../src/services/notificationPrefs.js');
const handler = await import('../../../src/handlers/notifications/handler.js');

const verify = capability.verifyUnsubscribeToken as unknown as ReturnType<typeof vi.fn>;
const disable = notificationPrefs.disableEmailCategory as unknown as ReturnType<typeof vi.fn>;

const ctx = {} as Context;
const event = (method: 'GET' | 'POST', query: Record<string, string> | null) =>
  ({
    // API Gateway populates routeKey per method, and the rate limiter keys on
    // it — so GET and POST get their own buckets, as they do in production.
    routeKey: `${method} /notifications/email/unsubscribe`,
    httpMethod: method,
    path: '/notifications/email/unsubscribe',
    headers: {},
    queryStringParameters: query,
    body: null,
    isBase64Encoded: false,
  }) as never;

beforeEach(async () => {
  vi.clearAllMocks();
  // The limiter's buckets are module-level and would otherwise carry over
  // between cases in this file.
  const { __resetRateLimitForTests } = await import('../../../src/middleware/rateLimit.js');
  __resetRateLimitForTests();
  process.env.PUBLIC_API_URL = 'https://api.example/prod';
  process.env.FRONTEND_URL = 'https://app.example';
});

describe('GET /notifications/email/unsubscribe', () => {
  it('renders a confirm form and changes NOTHING', async () => {
    // Mail clients and corporate link scanners fetch every URL in a message.
    // A mutating GET would unsubscribe people who never clicked.
    verify.mockResolvedValue({ status: 'ok', userId: 'u1', category: 'weekly_digest' });
    const res = await handler.emailUnsubscribeForm(event('GET', { t: 'tok' }), ctx);
    expect(res.statusCode).toBe(200);
    expect(res.headers?.['Content-Type']).toBe('text/html; charset=utf-8');
    expect(res.headers?.['Cache-Control']).toBe('no-store');
    expect(res.body).toContain('<form method="post"');
    expect(res.body).toContain('the weekly digest');
    expect(disable).not.toHaveBeenCalled();
  });

  it('renders the page in Spanish when the link says so', async () => {
    verify.mockResolvedValue({ status: 'ok', userId: 'u1', category: 'weekly_digest' });
    const res = await handler.emailUnsubscribeForm(event('GET', { t: 'tok', lang: 'es' }), ctx);
    expect(res.body).toContain('<html lang="es">');
    expect(res.body).toContain('el resumen semanal');
  });

  it('400s a request with no token', async () => {
    const res = await handler.emailUnsubscribeForm(event('GET', null), ctx);
    expect(res.statusCode).toBe(400);
    expect(verify).not.toHaveBeenCalled();
  });

  it('410s an invalid or expired link', async () => {
    verify.mockResolvedValue({ status: 'expired' });
    const res = await handler.emailUnsubscribeForm(event('GET', { t: 'tok' }), ctx);
    expect(res.statusCode).toBe(410);
    expect(res.body).toContain('This link no longer works');
  });

  it('503s — never "invalid" — when the capability store is unreachable', async () => {
    verify.mockResolvedValue({ status: 'unavailable' });
    const res = await handler.emailUnsubscribeForm(event('GET', { t: 'tok' }), ctx);
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain('nothing has been changed');
  });
});

describe('POST /notifications/email/unsubscribe', () => {
  it('turns off exactly the token’s category', async () => {
    verify.mockResolvedValue({ status: 'ok', userId: 'u1', category: 'year_recap' });
    disable.mockResolvedValue({});
    const res = await handler.emailUnsubscribe(event('POST', { t: 'tok' }), ctx);
    expect(res.statusCode).toBe(200);
    expect(disable).toHaveBeenCalledWith('u1', 'year_recap');
    expect(res.body).toContain('You are unsubscribed');
  });

  it('is idempotent, because a provider may retry the one-click POST', async () => {
    verify.mockResolvedValue({ status: 'ok', userId: 'u1', category: 'weekly_digest' });
    disable.mockResolvedValue({});
    await handler.emailUnsubscribe(event('POST', { t: 'tok' }), ctx);
    const second = await handler.emailUnsubscribe(event('POST', { t: 'tok' }), ctx);
    expect(second.statusCode).toBe(200);
    expect(disable).toHaveBeenCalledTimes(2);
  });

  it('never claims success for a write it could not make', async () => {
    verify.mockResolvedValue({ status: 'ok', userId: 'u1', category: 'weekly_digest' });
    disable.mockRejectedValue(new Error('ddb down'));
    const res = await handler.emailUnsubscribe(event('POST', { t: 'tok' }), ctx);
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain('nothing has been changed');
  });

  it('410s an invalid link without writing', async () => {
    verify.mockResolvedValue({ status: 'invalid' });
    const res = await handler.emailUnsubscribe(event('POST', { t: 'tok' }), ctx);
    expect(res.statusCode).toBe(410);
    expect(disable).not.toHaveBeenCalled();
  });
});

describe('rate limiting (js/missing-rate-limiting)', () => {
  // Both routes are unauthenticated and both make an authorization decision,
  // so both carry a per-IP throttle. The limits differ on purpose: GET is
  // generous because link prefetchers and corporate scanning proxies hammer
  // it from a shared egress IP and it mutates nothing; POST is tight because
  // it is the one that writes.
  it('throttles the GET at 30/min per IP, above what a prefetcher needs', async () => {
    verify.mockResolvedValue({ status: 'ok', userId: 'u1', category: 'weekly_digest' });
    const codes: number[] = [];
    for (let i = 0; i < 32; i++) {
      const res = await handler.emailUnsubscribeForm(event('GET', { t: 'tok' }), ctx);
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 30).every((c) => c === 200)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });

  it('throttles the POST at 10/min per IP', async () => {
    verify.mockResolvedValue({ status: 'ok', userId: 'u1', category: 'weekly_digest' });
    disable.mockResolvedValue({});
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await handler.emailUnsubscribe(event('POST', { t: 'tok' }), ctx);
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes.at(-1)).toBe(429);
    // The throttled requests never reached the write.
    expect(disable.mock.calls.length).toBe(10);
  });

  it('keys the two routes separately, so a prefetched GET cannot lock out the POST', async () => {
    verify.mockResolvedValue({ status: 'ok', userId: 'u1', category: 'weekly_digest' });
    disable.mockResolvedValue({});
    for (let i = 0; i < 31; i++)
      await handler.emailUnsubscribeForm(event('GET', { t: 'tok' }), ctx);
    const posted = await handler.emailUnsubscribe(event('POST', { t: 'tok' }), ctx);
    expect(posted.statusCode).toBe(200);
  });
});
