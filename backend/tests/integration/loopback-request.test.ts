import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import request, { boundAddress } from '../support/request';
import { app } from '../../src/local-server';

/**
 * Why the integration suites send requests through tests/support/request.ts,
 * reproduced inside this one test process. Every server started here is
 * closed before the test ends; nothing is bound outside it.
 *
 * supertest's own `request(app)` listened with `listen(0)` (every interface,
 * `::`) and then connected to 127.0.0.1. When another process held that same
 * port on 127.0.0.1, macOS let both binds succeed and routed the request to
 * the other process: the "run-digests" flake, a 404 on login and then a 401.
 */
const started: http.Server[] = [];
function listen(server: http.Server, port: number, host?: string): Promise<number> {
  started.push(server);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    const done = () => resolve((server.address() as AddressInfo).port);
    if (host) server.listen(port, host, done);
    else server.listen(port, done);
  });
}
const stranger = () =>
  http.createServer((_req, res) => {
    res.statusCode = 404;
    res.end('stranger');
  });
function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

afterEach(async () => {
  await Promise.all(
    started
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) =>
            server.listening ? server.close(() => resolve()) : resolve()
          )
      )
  );
});

describe('integration requests reach this app and nothing else', () => {
  it.runIf(process.platform === 'darwin')(
    'the old way: an app on `::` shares a port a stranger holds on 127.0.0.1, and loses its requests',
    async () => {
      const port = await listen(stranger(), 0, '127.0.0.1');
      await listen(http.createServer(app), port); // what supertest's listen(0) can land on
      const res = await get(port, '/health');
      expect(res).toEqual({ status: 404, body: 'stranger' });
    }
  );

  it('the loopback server cannot take a port a stranger holds on 127.0.0.1', async () => {
    const port = await listen(stranger(), 0, '127.0.0.1');
    await expect(listen(http.createServer(app), port, '127.0.0.1')).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });
  });

  it('requests through the helper reach this app, on 127.0.0.1, with a stranger running', async () => {
    await listen(stranger(), 0, '127.0.0.1');
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.request.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/health$/);
    // Bound to 127.0.0.1 itself, not every interface: the kernel only gave it
    // a port free there.
    expect(boundAddress()).toMatchObject({ address: '127.0.0.1', family: 'IPv4' });
  });
});
