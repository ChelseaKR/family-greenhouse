#!/usr/bin/env node
/**
 * Drift detector. Scans backend handlers for `// METHOD /path` comments and
 * verifies docs/api-spec.yaml documents each one. Exits non-zero on any
 * missing or mismatched entry so CI catches drift on the PR that introduces
 * it, not months later when an integrator hits a 404.
 *
 * Two normalization rules:
 *  - OpenAPI uses `{id}`, our handler comments use `:id`. We map both to a
 *    canonical `:id` form before comparing.
 *  - Path-suffix decorations after whitespace (e.g. `// GET /tasks  (public)`)
 *    are stripped. Anything after a query-string `?` is dropped too — query
 *    params live in the spec's `parameters` array, not the path.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HANDLERS_DIR = join(ROOT, 'backend', 'src', 'handlers');
const SPEC_FILE = join(ROOT, 'docs', 'api-spec.yaml');

const ROUTE_COMMENT = /^\/\/\s*(GET|POST|PUT|PATCH|DELETE)\s+(\/\S+)/;
const SPEC_PATH_LINE = /^\s\s(\/\S+):\s*$/;
const SPEC_METHOD_LINE = /^\s\s\s\s(get|post|put|patch|delete):\s*$/;

function canonicalPath(raw) {
  // Drop query-string and trailing whitespace decorations.
  const noQuery = raw.split('?')[0];
  // Convert OpenAPI {param} to handler :param so both sources canonicalize.
  return noQuery.replace(/\{([^}]+)\}/g, ':$1');
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function findHandlerRoutes() {
  const routes = new Set();
  for (const file of walk(HANDLERS_DIR)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (const line of lines) {
      const match = ROUTE_COMMENT.exec(line.trim());
      if (!match) continue;
      const [, method, path] = match;
      routes.add(`${method.toUpperCase()} ${canonicalPath(path)}`);
    }
  }
  return routes;
}

function findSpecRoutes() {
  const routes = new Set();
  const lines = readFileSync(SPEC_FILE, 'utf8').split('\n');
  let currentPath = null;
  for (const line of lines) {
    const pathMatch = SPEC_PATH_LINE.exec(line);
    if (pathMatch) {
      currentPath = canonicalPath(pathMatch[1]);
      continue;
    }
    const methodMatch = SPEC_METHOD_LINE.exec(line);
    if (methodMatch && currentPath) {
      routes.add(`${methodMatch[1].toUpperCase()} ${currentPath}`);
    }
  }
  return routes;
}

const handlerRoutes = findHandlerRoutes();
const specRoutes = findSpecRoutes();

const missingFromSpec = [...handlerRoutes].filter((r) => !specRoutes.has(r)).sort();
const orphanedInSpec = [...specRoutes].filter((r) => !handlerRoutes.has(r)).sort();

if (missingFromSpec.length === 0 && orphanedInSpec.length === 0) {
  console.log(`API spec OK — ${handlerRoutes.size} handler routes documented.`);
  process.exit(0);
}

if (missingFromSpec.length > 0) {
  console.error(`\n❌ ${missingFromSpec.length} handler route(s) missing from docs/api-spec.yaml:`);
  for (const r of missingFromSpec) console.error(`   ${r}`);
}

if (orphanedInSpec.length > 0) {
  console.error(
    `\n⚠️  ${orphanedInSpec.length} spec route(s) with no handler — stale entries to remove:`
  );
  for (const r of orphanedInSpec) console.error(`   ${r}`);
}

console.error('\nUpdate docs/api-spec.yaml to match, or fix the route comment in the handler.');
process.exit(1);
