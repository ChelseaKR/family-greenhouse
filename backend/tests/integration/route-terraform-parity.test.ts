/**
 * Contract regression guard: the HTTP routes API Gateway actually wires
 * (`infrastructure/modules/api/main.tf`, the `local.routes` map driving the
 * `aws_apigatewayv2_route` for_each) must EXACTLY match the union of every
 * handler group's `createRouter` route keys.
 *
 * Why this exists: `route-parity.test.ts` keeps handlers ↔ local-server honest
 * and `scripts/check-api-spec.mjs` keeps handlers ↔ OpenAPI honest, but nothing
 * checked handlers ↔ Terraform. A route added to a handler but forgotten in
 * main.tf deploys as a 404 (no integration wired); a route left in main.tf
 * after its handler is removed wires an integration to nothing. Either way no
 * other gate catches it — this asserts set-equality so CI does (H7).
 *
 * Importing the handler modules is safe under vitest (NODE_ENV=test sentinels;
 * AWS clients are constructed-but-never-called at load) — same rationale as
 * route-parity.test.ts.
 *
 * The streaming chat route (`POST /chat/messages/stream`) is intentionally
 * NOT in `local.routes` (it's a standalone RESPONSE_STREAM Lambda with its own
 * `aws_apigatewayv2_route` resource) and is NOT in any `createRouter` (its
 * handler is `streamHandler`, not a router), so it sits outside both sets and
 * doesn't break the equality.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

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

// EventBridge-invoked handlers (reminders/digests/year-recap scans) have no
// HTTP route table, so they have nothing to mirror here.
const GROUPS: Array<{ handler: { routes: string[] } }> = [
  apiH,
  apiKeysH,
  authH,
  billingH,
  chatH,
  climateH,
  householdsH,
  meH,
  notificationsH,
  plantsH,
  speciesH,
  tasksH,
];

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN_TF = resolve(__dirname, '../../../infrastructure/modules/api/main.tf');

const ROUTE_KEY = /^"((?:GET|POST|PUT|DELETE|PATCH) \/[^"]*)"\s*=/;

/**
 * Parse the `route_key` strings out of the `local.routes` map in main.tf.
 * Walks from `routes = {` to its matching close brace, pulling each
 * `"METHOD /path" = { ... }` map key.
 */
function terraformRouteKeys(): Set<string> {
  const src = readFileSync(MAIN_TF, 'utf8');
  const lines = src.split('\n');

  const start = lines.findIndex((l) => /^\s*routes\s*=\s*\{/.test(l));
  if (start === -1) {
    throw new Error('could not find the `routes = {` block in main.tf');
  }

  const keys = new Set<string>();
  let depth = 0;
  let started = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    // Track brace depth so we stop at the map's matching close brace and don't
    // wander into later locals.
    for (const ch of line) {
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
    }
    started = true;
    const m = ROUTE_KEY.exec(line.trim());
    if (m) keys.add(m[1]);
    if (started && depth === 0) break;
  }
  return keys;
}

/** Union of every handler group's createRouter keys. */
function handlerRouteKeys(): Set<string> {
  const out = new Set<string>();
  for (const mod of GROUPS) {
    for (const key of mod.handler.routes) out.add(key);
  }
  return out;
}

describe('handler routes ↔ Terraform route table parity', () => {
  it('every handler route is wired in main.tf and vice-versa (set equality)', () => {
    const tf = terraformRouteKeys();
    const handlers = handlerRouteKeys();

    // Sanity: both sides actually parsed something.
    expect(tf.size).toBeGreaterThan(0);
    expect(handlers.size).toBeGreaterThan(0);

    const missingInTf = [...handlers].filter((r) => !tf.has(r)).sort();
    const missingInHandlers = [...tf].filter((r) => !handlers.has(r)).sort();

    expect(
      missingInTf,
      `Handler routes NOT wired in infrastructure/modules/api/main.tf ` +
        `(they would deploy as 404s): ${JSON.stringify(missingInTf)}`
    ).toEqual([]);
    expect(
      missingInHandlers,
      `Routes in main.tf with no matching handler createRouter key ` +
        `(integration wired to nothing): ${JSON.stringify(missingInHandlers)}`
    ).toEqual([]);
  });
});
