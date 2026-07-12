import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Context } from 'aws-lambda';
import { createRouter } from '../../../src/middleware/router.js';

import * as apiH from '../../../src/handlers/api/handler.js';
import * as apiKeysH from '../../../src/handlers/apiKeys/handler.js';
import * as authH from '../../../src/handlers/auth/handler.js';
import * as billingH from '../../../src/handlers/billing/handler.js';
import * as climateH from '../../../src/handlers/climate/handler.js';
import * as householdsH from '../../../src/handlers/households/handler.js';
import * as meH from '../../../src/handlers/me/handler.js';
import * as notificationsH from '../../../src/handlers/notifications/handler.js';
import * as plantsH from '../../../src/handlers/plants/handler.js';
import * as speciesH from '../../../src/handlers/species/handler.js';
import * as tasksH from '../../../src/handlers/tasks/handler.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const HANDLERS_DIR = join(HERE, '../../../src/handlers');
const ctx = {} as Context;

describe('createRouter', () => {
  const ok = (id: string) => Promise.resolve({ statusCode: 200, body: id });
  const routes = {
    'GET /plants': () => ok('list'),
    'GET /plants/{id}': () => ok('get'),
  };

  it('dispatches on the v2 routeKey', async () => {
    const handler = createRouter(routes);
    const res = await handler({ routeKey: 'GET /plants/{id}' }, ctx);
    expect(res.body).toBe('get');
  });

  it('falls back to method + resource for v1 (REST) events', async () => {
    const handler = createRouter(routes);
    const res = await handler({ httpMethod: 'GET', resource: '/plants' }, ctx);
    expect(res.body).toBe('list');
  });

  it('404s an unmatched route', async () => {
    const handler = createRouter(routes);
    const res = await handler({ routeKey: 'DELETE /plants/{id}' }, ctx);
    expect(res.statusCode).toBe(404);
  });

  it('stamps security + CORS headers on the inline 404 (it bypasses the middy stack)', async () => {
    // Without these the browser reports an opaque CORS failure instead of
    // surfacing the 404 to the frontend.
    const handler = createRouter(routes);
    const res = await handler(
      {
        routeKey: 'DELETE /plants/{id}',
        headers: { origin: 'http://localhost:3000' },
      },
      ctx
    );
    expect(res.headers).toMatchObject({
      'Content-Type': 'application/json',
      'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'Access-Control-Allow-Credentials': 'true',
      Vary: 'Origin',
    });
    expect(typeof res.headers?.['Access-Control-Allow-Origin']).toBe('string');
    expect(res.headers?.['Access-Control-Allow-Origin']).not.toBe('');
  });

  it('does not authorize an unknown origin on an inline 404', async () => {
    const handler = createRouter(routes);
    const res = await handler(
      {
        routeKey: 'DELETE /plants/{id}',
        headers: { origin: 'https://attacker.example' },
      },
      ctx
    );
    expect(res.headers?.['Access-Control-Allow-Origin']).toBeUndefined();
    expect(res.headers?.Vary).toBe('Origin');
  });

  it('exposes its route keys', () => {
    expect(createRouter(routes).routes).toEqual(['GET /plants', 'GET /plants/{id}']);
  });
});

/**
 * Drift guard: every `// METHOD /path` route comment in a handler group must
 * have a matching entry in that group's `handler` dispatcher. This is what
 * makes the hand-written route maps safe — add a route without wiring its
 * dispatch and this fails. `runReminders` (EventBridge-invoked, no HTTP route
 * comment) is intentionally not an HTTP route, so it's excluded by having no
 * comment to match.
 */
const GROUPS: Record<string, { handler: { routes: string[] } }> = {
  api: apiH,
  apiKeys: apiKeysH,
  auth: authH,
  billing: billingH,
  climate: climateH,
  households: householdsH,
  me: meH,
  notifications: notificationsH,
  plants: plantsH,
  species: speciesH,
  tasks: tasksH,
};

// Match both `// METHOD /path` line comments AND ` * METHOD /path` JSDoc lines.
// Previously this regex missed JSDoc-style route docs (e.g. notifications/
// run-reminders) — and was the reason a couple unregistered routes shipped
// to production. Code review 2026-06-01.
const ROUTE_COMMENT = /^(?:\/\/|\*)\s*(GET|POST|PUT|PATCH|DELETE|OPTIONS)\s+(\/\S+)/;

function canonical(raw: string): string {
  return raw.split('?')[0].replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function commentedRoutes(group: string): string[] {
  const src = readFileSync(join(HANDLERS_DIR, group, 'handler.ts'), 'utf8');
  const out: string[] = [];
  for (const line of src.split('\n')) {
    const m = ROUTE_COMMENT.exec(line.trim());
    if (m) out.push(`${m[1]} ${canonical(m[2])}`);
  }
  return out;
}

describe('dispatcher route coverage (no drift)', () => {
  for (const [group, mod] of Object.entries(GROUPS)) {
    it(`${group}: every documented route is dispatched`, () => {
      const dispatched = new Set(mod.handler.routes);
      const documented = commentedRoutes(group);
      expect(documented.length).toBeGreaterThan(0);
      for (const route of documented) {
        expect(dispatched, `${group} dispatcher is missing ${route}`).toContain(route);
      }
    });
  }
});
