import http from 'node:http';
import { afterAll, beforeAll } from 'vitest';
import supertest from 'supertest';
import { app } from '../../src/local-server';

/**
 * `request(app)` for the integration suites, on a server bound to 127.0.0.1.
 *
 * supertest's own `request(app)` starts a fresh server per call with
 * `listen(0)`, which binds every interface (`::`), then connects to
 * `127.0.0.1:<port>`. On macOS a port can be bound on `::` while another
 * process holds the same port on 127.0.0.1 alone, and the more specific
 * binding wins: the request lands on that other process. On a machine running
 * other dev servers this failed at random, as a 404 ("No route handler")
 * or a 401 from a stranger, most often in `loginAsSeed`.
 *
 * Bound to 127.0.0.1 explicitly, the kernel only hands out a port that is free
 * there, so the request can only reach this app. One server per test file,
 * started before its tests and closed after them.
 */
let server: http.Server | null = null;

beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(0, '127.0.0.1', () => resolve());
  });
});

afterAll(async () => {
  const closing = server;
  server = null;
  if (closing) await new Promise<void>((resolve) => closing.close(() => resolve()));
});

/** Same call shape as supertest's default export: `request(app).get(...)`. */
export default function request(target: unknown) {
  if (target !== app) return supertest(target as Parameters<typeof supertest>[0]);
  if (!server?.listening) {
    throw new Error('tests/support/request: the loopback server is not running yet');
  }
  return supertest(server);
}

/** Where the loopback server is bound (for the test that pins it). */
export function boundAddress() {
  return server?.address() ?? null;
}
