import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import {
  classifyStatus,
  postWebhook,
  type RequestFn,
} from '../../../src/services/channelWebhookTransport.js';
import { BlockedAddressError } from '../../../src/services/channelSsrfGuard.js';

const DISCORD =
  'https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdefghijklmnopqrstuvwx';

interface FakeCall {
  url: URL;
  options: RequestOptions;
  body: string;
}

/**
 * A stand-in for `https.request` that answers with a scripted status (or a
 * scripted error) and records exactly what it was asked to send.
 */
function fakeRequest(
  script:
    | { status: number; headers?: Record<string, string>; body?: string }
    | { error: Error }
    | { hang: true }
): { request: RequestFn; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const request: RequestFn = (url, options, callback) => {
    const req = new EventEmitter() as ClientRequest & EventEmitter;
    const call: FakeCall = { url, options, body: '' };
    calls.push(call);
    (req as unknown as { destroy: (err?: Error) => void }).destroy = (err?: Error) => {
      if (err) queueMicrotask(() => req.emit('error', err));
    };
    (req as unknown as { end: (chunk: Buffer) => void }).end = (chunk: Buffer) => {
      call.body = chunk.toString('utf8');
      queueMicrotask(() => {
        if ('error' in script) {
          req.emit('error', script.error);
          return;
        }
        if ('hang' in script) {
          req.emit('timeout');
          return;
        }
        const res = new EventEmitter() as IncomingMessage & EventEmitter;
        res.statusCode = script.status;
        res.headers = script.headers ?? {};
        (res as unknown as { destroy: () => void }).destroy = () => res.emit('close');
        callback(res);
        if (script.body) res.emit('data', Buffer.from(script.body));
        res.emit('end');
      });
    };
    return req;
  };
  return { request, calls };
}

const lookup = vi.fn() as unknown as RequestOptions['lookup'];

describe('classifyStatus', () => {
  it.each([
    [200, { ok: true }],
    [204, { ok: true }],
    [301, { ok: false, kind: 'redirect' }],
    [307, { ok: false, kind: 'redirect' }],
    [400, { ok: false, kind: 'client' }],
    [401, { ok: false, kind: 'client' }],
    [404, { ok: false, kind: 'client' }],
    [410, { ok: false, kind: 'client' }],
    [429, { ok: false, kind: 'rate_limited' }],
    [500, { ok: false, kind: 'server' }],
    [503, { ok: false, kind: 'server' }],
  ])('%i → %o', (status, expected) => {
    expect(classifyStatus(status)).toMatchObject(expected);
  });
});

describe('postWebhook', () => {
  it('POSTs JSON once, through the guarded lookup, and reports a 204 as delivered', async () => {
    const { request, calls } = fakeRequest({ status: 204 });
    const outcome = await postWebhook('discord', DISCORD, { content: 'hi' }, { request, lookup });
    expect(outcome).toEqual({ ok: true, httpStatus: 204 });
    expect(calls).toHaveLength(1);
    expect(calls[0].options.method).toBe('POST');
    expect(calls[0].options.lookup).toBe(lookup);
    expect(calls[0].options.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(JSON.parse(calls[0].body)).toEqual({ content: 'hi' });
    expect(calls[0].url.hostname).toBe('discord.com');
  });

  it('does NOT follow a redirect: one request, reported as `redirect`', async () => {
    const { request, calls } = fakeRequest({
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data/' },
    });
    const outcome = await postWebhook('discord', DISCORD, {}, { request, lookup });
    expect(outcome).toMatchObject({ ok: false, kind: 'redirect', httpStatus: 302 });
    expect(calls).toHaveLength(1);
  });

  it('carries Retry-After from a 429', async () => {
    const { request } = fakeRequest({ status: 429, headers: { 'retry-after': '120' } });
    const outcome = await postWebhook('discord', DISCORD, {}, { request, lookup });
    expect(outcome).toEqual({
      ok: false,
      kind: 'rate_limited',
      httpStatus: 429,
      retryAfterSeconds: 120,
    });
  });

  it('reports a 404 (webhook deleted) as a client error and never returns the body', async () => {
    const { request } = fakeRequest({
      status: 404,
      body: '{"message":"Unknown Webhook","code":10015}',
    });
    const outcome = await postWebhook('discord', DISCORD, {}, { request, lookup });
    expect(outcome).toEqual({
      ok: false,
      kind: 'client',
      httpStatus: 404,
      retryAfterSeconds: null,
    });
    expect(JSON.stringify(outcome)).not.toContain('Unknown Webhook');
  });

  it('turns the SSRF guard’s refusal into `blocked`', async () => {
    const { request } = fakeRequest({ error: new BlockedAddressError() });
    const outcome = await postWebhook('discord', DISCORD, {}, { request, lookup });
    expect(outcome).toMatchObject({ ok: false, kind: 'blocked', httpStatus: null });
  });

  it('reports a socket error or timeout as `network`, never throws', async () => {
    const reset = fakeRequest({
      error: Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }),
    });
    await expect(postWebhook('discord', DISCORD, {}, reset)).resolves.toMatchObject({
      ok: false,
      kind: 'network',
    });
    const hang = fakeRequest({ hang: true });
    await expect(
      postWebhook('discord', DISCORD, {}, { request: hang.request, lookup })
    ).resolves.toMatchObject({ ok: false, kind: 'network' });
  });

  it('re-validates the address and never opens a request for one the allow-list refuses', async () => {
    const { request, calls } = fakeRequest({ status: 204 });
    for (const bad of [
      'http://discord.com/api/webhooks/1/x',
      'https://169.254.169.254/webhook/abcdefgh',
      'https://discord.com.evil.example/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz',
    ]) {
      await expect(postWebhook('discord', bad, {}, { request, lookup })).resolves.toMatchObject({
        ok: false,
        kind: 'blocked',
      });
    }
    expect(calls).toHaveLength(0);
    // Negative control: the same fake does get called for a good address.
    await postWebhook('discord', DISCORD, {}, { request, lookup });
    expect(calls).toHaveLength(1);
  });

  it('survives a request constructor that throws', async () => {
    const request: RequestFn = () => {
      throw new Error('bad options');
    };
    await expect(postWebhook('discord', DISCORD, {}, { request, lookup })).resolves.toMatchObject({
      ok: false,
      kind: 'network',
    });
  });
});
