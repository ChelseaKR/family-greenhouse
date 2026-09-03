/**
 * The API's Sentry privacy posture: a no-op without SENTRY_DSN (not even the
 * dynamic import), initialised once per cold start when set, and — when it
 * does run — every identity-bearing collection category is off and the
 * `beforeSend` hook drops the caller from a crash report.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { init, wrapHandler } = vi.hoisted(() => ({
  init: vi.fn(),
  wrapHandler: vi.fn((handler: unknown) => handler),
}));
vi.mock('@sentry/aws-serverless', () => ({ init, wrapHandler }));

const DSN = 'https://public@o1.ingest.sentry.io/1';
const originalDsn = process.env.SENTRY_DSN;

beforeEach(() => {
  vi.resetModules();
  init.mockClear();
  wrapHandler.mockClear();
  delete process.env.SENTRY_DSN;
});

afterEach(() => {
  if (originalDsn === undefined) delete process.env.SENTRY_DSN;
  else process.env.SENTRY_DSN = originalDsn;
});

describe('backend Sentry', () => {
  it('is a no-op without SENTRY_DSN — the handler is returned unwrapped', async () => {
    const { initSentry, instrument } = await import('../../../src/utils/sentry.js');
    const handler = vi.fn();
    expect(instrument(handler)).toBe(handler);
    await expect(initSentry()).resolves.toBeNull();
    expect(init).not.toHaveBeenCalled();
    expect(wrapHandler).not.toHaveBeenCalled();
  });

  it('initialises once per cold start with every identity-bearing category off', async () => {
    process.env.SENTRY_DSN = DSN;
    const { initSentry, scrubSentryEvent } = await import('../../../src/utils/sentry.js');
    await initSentry();
    await initSentry();

    expect(init).toHaveBeenCalledTimes(1);
    const options = init.mock.calls[0][0] as Record<string, unknown>;
    expect(options).toMatchObject({
      dsn: DSN,
      includeLocalVariables: false,
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: { request: false, response: false },
        httpBodies: [],
        urlQueryParams: false,
        stackFrameVariables: false,
      },
    });
    expect(options.sendDefaultPii).not.toBe(true);
    expect(options.beforeSend).toBe(scrubSentryEvent);
  });

  it('wraps the handler lazily and forwards the invocation', async () => {
    process.env.SENTRY_DSN = DSN;
    const { instrument } = await import('../../../src/utils/sentry.js');
    const handler = vi.fn().mockResolvedValue({ statusCode: 200 });
    const wrapped = instrument(handler as (...args: unknown[]) => unknown);
    expect(wrapped).not.toBe(handler);

    await expect(wrapped({ rawPath: '/plants' }, { awsRequestId: 'r1' })).resolves.toEqual({
      statusCode: 200,
    });
    expect(wrapHandler).toHaveBeenCalledWith(handler);
    expect(handler).toHaveBeenCalledWith({ rawPath: '/plants' }, { awsRequestId: 'r1' });
  });

  it('beforeSend keeps the stack trace and drops the caller', async () => {
    const { scrubSentryEvent } = await import('../../../src/utils/sentry.js');
    const stacktrace = { frames: [{ filename: 'handler.js', function: 'route', lineno: 1 }] };
    const event = {
      user: { id: 'cognito-sub', ip_address: '203.0.113.9' },
      request: {
        url: 'https://api.example.test/chat/messages?turn=1',
        headers: { authorization: 'Bearer secret' },
        data: '{"message":"my plant Fred is wilting"}',
      },
      exception: { values: [{ type: 'Error', value: 'boom', stacktrace }] },
      contexts: { 'aws.lambda': { function_name: 'api', aws_request_id: 'r1' } },
    };

    const scrubbed = scrubSentryEvent(event as never) as unknown as typeof event;

    expect(scrubbed).toEqual({
      exception: { values: [{ type: 'Error', value: 'boom', stacktrace }] },
      contexts: { 'aws.lambda': { function_name: 'api', aws_request_id: 'r1' } },
    });
    expect(JSON.stringify(scrubbed)).not.toMatch(/cognito-sub|203\.0\.113\.9|Bearer|Fred/u);
  });
});
