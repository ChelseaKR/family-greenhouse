import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { collectSites, declaredRoutes, matchesRoute, readPath } from './check-app-links.mjs';

/** The route table's shape, trimmed to the part #721 turned on. */
const APP_TSX = [
  '<Route path="/" element={<LandingPage />} />',
  '<Route path="/settings" element={<SettingsPage />} />',
  '<Route path="/settings/billing" element={<SettingsPage />} />',
  '<Route path="/join/:inviteCode" element={<JoinHouseholdPage />} />',
  '<Route path="*" element={<NotFoundPage />} />',
].join('\n');

test('the catch-all is parsed but never counted as a match', () => {
  const { paths, catchAll } = declaredRoutes(APP_TSX);
  assert.equal(catchAll, true);
  assert.ok(!paths.includes('*'));
  // This is the whole point: `*` matching everything is what made a dead link
  // render a page instead of an error, so it must not make the gate pass.
  assert.equal(matchesRoute('/settings/notifications', paths), false);
});

test('an empty parse throws rather than passing over nothing', () => {
  assert.throws(() => declaredRoutes('const App = () => null;'), /No routes parsed/u);
});

test('the URL from #721 is dead and the fix resolves', () => {
  const { paths } = declaredRoutes(APP_TSX);
  assert.equal(matchesRoute('/settings/notifications', paths), false);
  assert.equal(matchesRoute('/settings?section=notifications', paths), true);
});

test(':param matches exactly one non-empty segment', () => {
  const { paths } = declaredRoutes(APP_TSX);
  assert.equal(matchesRoute('/join/abc123', paths), true);
  assert.equal(matchesRoute('/join/', paths), false);
  assert.equal(matchesRoute('/join/abc/extra', paths), false);
});

test('an interpolation in the path becomes one :param segment', () => {
  // Read from just after `${baseUrl}`. Before this was fixed the brace counter
  // opened on `$` instead of `{`, so the path kept the raw `${...}` text and
  // only matched by luck.
  const at = (line, marker) => readPath(line, line.indexOf(marker));
  assert.equal(at('url: `${baseUrl}/join/${invite.code}`,', '/join'), '/join/:param');
  assert.equal(
    at('return appUrl(`/plants/${encodeURIComponent(plantId)}`);', '/plants'),
    '/plants/:param'
  );
});

test('a foreign origin is dismissed by name, an app origin is examined', () => {
  const dir = mkdtempSync(join(tmpdir(), 'app-links-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'assets.ts'),
      [
        'function f(key: string) {',
        '  const base = process.env.ASSETS_BASE_URL;',
        '  return `${base}/thumbs/small`;',
        '}',
      ].join('\n')
    );
    writeFileSync(
      join(dir, 'src', 'email.ts'),
      [
        'function f() {',
        '  const base = process.env.FRONTEND_URL;',
        '  return `${base}/settings/notifications`;',
        '}',
      ].join('\n')
    );
    const { sites, dismissed, unresolved } = collectSites([join(dir, 'src')]);
    assert.deepEqual(
      sites.map((s) => s.path),
      ['/settings/notifications']
    );
    assert.equal(dismissed.length, 1);
    assert.match(dismissed[0].why, /asset origin/u);
    assert.equal(unresolved.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an origin-shaped identifier with an unclassifiable binding is unresolved, not fine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'app-links-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'mystery.ts'),
      [
        'function f() {',
        '  const baseUrl = somewhereElse();',
        '  return `${baseUrl}/settings`;',
        '}',
      ].join('\n')
    );
    const { sites, unresolved } = collectSites([join(dir, 'src')]);
    assert.equal(sites.length, 0);
    assert.equal(unresolved.length, 1);
    assert.equal(unresolved[0].ident, 'baseUrl');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a path documented in a comment is not a site', () => {
  const dir = mkdtempSync(join(tmpdir(), 'app-links-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'doc.ts'),
      [
        '// the SPA has no /tasks/:id route, so taskUrl lands on the plant',
        'function f() {',
        '  const base = process.env.FRONTEND_URL;',
        '  return `${base}/tasks`;',
        '}',
      ].join('\n')
    );
    const { sites } = collectSites([join(dir, 'src')]);
    assert.deepEqual(
      sites.map((s) => s.path),
      ['/tasks']
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
