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
    httpMethod: method,
    path: '/notifications/email/unsubscribe',
    headers: {},
    queryStringParameters: query,
    body: null,
    isBase64Encoded: false,
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
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
