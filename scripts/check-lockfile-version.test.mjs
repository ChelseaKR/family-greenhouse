import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { evaluate, readManifests } from './check-lockfile-version.mjs';

/**
 * The real files in this repository, not a fixture.
 *
 * A gate whose tests only ever see hand-built objects can pass while the thing
 * it guards is broken, so the positive case below is the actual tree.
 */
const realManifests = () => readManifests();
const realLock = () => JSON.parse(readFileSync('package-lock.json', 'utf8'));

/** Deep copy, so a sabotage cannot leak into another test. */
const copy = (value) => JSON.parse(JSON.stringify(value));

test('this repository agrees with its own lockfile', () => {
  assert.deepEqual(evaluate({ manifests: realManifests(), lock: realLock() }), []);
});

// --- negative controls ------------------------------------------------------
//
// Each of these sabotages the real lockfile and asserts the gate goes red. The
// assertion that the MUTATION LANDED comes first in every one: a sabotage that
// silently no-ops (a key that moved, a path that never existed) leaves the
// check passing for the honest reason, and the test then reads as proof the
// gate works when it has proved nothing at all.

test('a lockfile left a release behind fails, naming both versions', () => {
  const manifests = realManifests();
  const lock = copy(realLock());

  const before = lock.version;
  lock.version = '0.0.1-stale';
  assert.notEqual(lock.version, before, 'sabotage did not apply: top-level version unchanged');
  assert.notEqual(lock.version, manifests[''], 'sabotage produced a version that still agrees');

  const failures = evaluate({ manifests, lock });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /top-level `version` is 0\.0\.1-stale/);
  assert.match(failures[0], new RegExp(`says ${manifests[''].replace(/\./g, '\\.')}`));
});

test('the root `""` entry drifting on its own fails', () => {
  const manifests = realManifests();
  const lock = copy(realLock());

  const before = lock.packages[''].version;
  lock.packages[''].version = '0.0.2-stale';
  assert.notEqual(lock.packages[''].version, before, 'sabotage did not apply');

  const failures = evaluate({ manifests, lock });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /root entry.*says 0\.0\.2-stale/s);
});

test('a workspace entry drifting fails, naming that workspace', () => {
  const manifests = realManifests();
  const lock = copy(realLock());
  const workspace = Object.keys(manifests).find((path) => path !== '');
  assert.ok(workspace, 'package.json declares no workspaces; this test would check nothing');

  const before = lock.packages[workspace].version;
  lock.packages[workspace].version = '0.0.3-stale';
  assert.notEqual(lock.packages[workspace].version, before, 'sabotage did not apply');

  const failures = evaluate({ manifests, lock });
  assert.equal(failures.length, 1);
  assert.match(failures[0], new RegExp(`workspace \`${workspace}\` says 0\\.0\\.3-stale`));
});

test('every one of the four recorded places is actually compared', () => {
  // The shape this guards against is a check that reads one field and reports
  // agreement for all of them. Drift all four at once and the gate must raise
  // four failures, not one.
  const manifests = realManifests();
  const lock = copy(realLock());
  lock.version = '9.9.9';
  for (const path of Object.keys(manifests)) lock.packages[path].version = '9.9.9';

  const failures = evaluate({ manifests, lock });
  assert.equal(failures.length, 1 + Object.keys(manifests).length);
});

// --- shapes that would make the check pass over nothing ----------------------

test('a missing `packages` map fails rather than checking an empty set', () => {
  const manifests = realManifests();
  const lock = copy(realLock());
  delete lock.packages;
  assert.equal(lock.packages, undefined, 'sabotage did not apply');

  const failures = evaluate({ manifests, lock });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /no `packages` map/);
});

test('a workspace missing from the lockfile fails rather than being skipped', () => {
  const manifests = realManifests();
  const lock = copy(realLock());
  const workspace = Object.keys(manifests).find((path) => path !== '');

  assert.ok(workspace in lock.packages, 'sabotage would not apply: workspace already absent');
  delete lock.packages[workspace];

  const failures = evaluate({ manifests, lock });
  assert.equal(failures.length, 1);
  assert.match(failures[0], new RegExp(`no entry for workspace \`${workspace}\``));
});

test('an entry with no version at all fails', () => {
  const manifests = realManifests();
  const lock = copy(realLock());

  assert.notEqual(lock.packages[''].version, undefined, 'sabotage would not apply');
  delete lock.packages[''].version;

  const failures = evaluate({ manifests, lock });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /records no `version`/);
});

test('a missing top-level version fails', () => {
  const manifests = realManifests();
  const lock = copy(realLock());

  assert.notEqual(lock.version, undefined, 'sabotage would not apply');
  delete lock.version;

  const failures = evaluate({ manifests, lock });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /no top-level `version` field/);
});
