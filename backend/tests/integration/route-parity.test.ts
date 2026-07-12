/**
 * Contract regression guard: the mock dev server (src/local-server.ts) must
 * register an Express route for EVERY route in the production route tables.
 *
 * Each production handler group exports `handler.routes` (the createRouter
 * keys, e.g. "GET /plants/{id}"). We translate API Gateway's `{param}`
 * placeholders to Express's `:param` form and assert the mock app has a
 * matching method+path registration. Add a route to a Lambda dispatcher
 * without mirroring it in the mock and this test fails CI — which is the
 * point: the integration suite tests the mock, so an unmirrored route is an
 * untested route.
 *
 * Importing the handler modules is safe under vitest: NODE_ENV=test makes
 * utils/env.requireEnv return sentinels, and the AWS SDK clients are only
 * constructed (never called) at module load. If a future handler group can't
 * be imported cleanly, exclude it from GROUPS with a comment explaining why.
 */
import { describe, expect, it } from 'vitest';
import { app } from '../../src/local-server';

import * as apiH from '../../src/handlers/api/handler.js';
import * as apiKeysH from '../../src/handlers/apiKeys/handler.js';
import * as authH from '../../src/handlers/auth/handler.js';
import * as billingH from '../../src/handlers/billing/handler.js';
import * as chatH from '../../src/handlers/chat/handler.js';
import * as climateH from '../../src/handlers/climate/handler.js';
import * as householdsH from '../../src/handlers/households/handler.js';
import * as meH from '../../src/handlers/me/handler.js';
import * as notificationsH from '../../src/handlers/notifications/handler.js';
import * as plantsH from '../../src/handlers/plants/handler.js';
import * as speciesH from '../../src/handlers/species/handler.js';
import * as tasksH from '../../src/handlers/tasks/handler.js';

// handlers/reminders is EventBridge-invoked (no HTTP route table), so it has
// nothing to mirror and is intentionally absent here.
const GROUPS: Record<string, { handler: { routes: string[] } }> = {
  api: apiH,
  apiKeys: apiKeysH,
  auth: authH,
  billing: billingH,
  chat: chatH,
  climate: climateH,
  households: householdsH,
  me: meH,
  notifications: notificationsH,
  plants: plantsH,
  species: speciesH,
  tasks: tasksH,
};

/** API Gateway routeKey ("GET /plants/{id}") → Express form ("GET /plants/:id"). */
function toExpressKey(routeKey: string): string {
  return routeKey.replace(/\{([^}]+)\+\}/g, '*$1').replace(/\{([^}]+)\}/g, ':$1');
}

/** Every "METHOD /path" the mock Express app has registered. */
function mockRegisteredRoutes(): Set<string> {
  const out = new Set<string>();
  // Express 5: route layers live on app.router.stack with .route populated
  // (Express 4 exposed the same shape via app._router.stack).
  const stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> = (
    app as unknown as { router: { stack: never[] } }
  ).router.stack;
  for (const layer of stack) {
    if (!layer.route) continue;
    for (const [method, enabled] of Object.entries(layer.route.methods)) {
      if (enabled) out.add(`${method.toUpperCase()} ${layer.route.path}`);
    }
  }
  return out;
}

describe('mock ↔ production route parity', () => {
  const registered = mockRegisteredRoutes();

  for (const [group, mod] of Object.entries(GROUPS)) {
    it(`${group}: the mock registers every production route`, () => {
      expect(mod.handler.routes.length).toBeGreaterThan(0);
      for (const routeKey of mod.handler.routes) {
        expect(
          registered,
          `local-server.ts is missing production route "${routeKey}" ` +
            `(expected Express registration "${toExpressKey(routeKey)}")`
        ).toContain(toExpressKey(routeKey));
      }
    });
  }
});
