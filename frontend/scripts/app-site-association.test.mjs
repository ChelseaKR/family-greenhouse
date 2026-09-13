/**
 * The iOS universal-link claim, pinned.
 *
 * `build-app-site-association.mjs --check` already re-derives the whole file
 * on every gate run, so what these tests add is the layer underneath it: the
 * WILDCARD SEMANTICS the derivation rests on. Apple's two primary sources
 * disagree about whether `*` crosses a `/` (the docs' example comments read as
 * prefix matching; WWDC19 session 717 says matching works "the same way it is
 * in terminal"), and this repository resolves that by choosing the reading
 * that is correct under both. That choice is invisible in the generated file —
 * it shows up only as one extra component — so it is asserted here, where
 * changing it fails loudly instead of quietly widening or narrowing what the
 * app claims.
 *
 * Run by `npm run test:edge`, which is a step of `npm run verify` and of CI's
 * Test Frontend job.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { declaredRoutePaths, sampleUrlFor } from './app-routes.mjs';
import {
  BUNDLE_ID,
  TEAM_ID,
  TEAM_ID_PATTERN,
  TEAM_ID_PLACEHOLDER,
  committedAssociation,
  componentPatterns,
  matchesComponent,
  partitionRoutes,
  renderAssociation,
} from './app-site-association.mjs';

const committed = JSON.parse(committedAssociation());
const detail = committed.applinks.details[0];
const patterns = detail.components.map((component) => component['/']);
const claims = (url) => patterns.filter((pattern) => matchesComponent(pattern, url));

test('a component matches the whole path, not a prefix', () => {
  assert.ok(matchesComponent('/account', '/account'));
  assert.ok(!matchesComponent('/account', '/account-deletion'));
  assert.ok(!matchesComponent('/account', '/account/settings'));
  assert.ok(!matchesComponent('/tag/*', '/tags'));
});

test('`*` matches one path segment and never crosses a slash', () => {
  assert.ok(matchesComponent('/plants/*', '/plants/new'));
  assert.ok(matchesComponent('/plants/*', '/plants/abc-123'));
  // The conservative reading. If this ever becomes false the file claims more
  // than it says it does, and `/sit/*/brief` silently becomes redundant.
  assert.ok(!matchesComponent('/plants/*', '/plants/a/b'));
  assert.ok(!matchesComponent('/sit/*', '/sit/token/brief'));
  assert.ok(matchesComponent('/sit/*/brief', '/sit/token/brief'));
});

test('`?` matches exactly one character, and not a slash', () => {
  assert.ok(matchesComponent('/pl?nts', '/plants'));
  assert.ok(!matchesComponent('/pl?nts', '/plnts'));
  assert.ok(!matchesComponent('/a?b', '/a/b'));
});

test('the appID is <Team ID>.<bundle id>, with a real Team ID', () => {
  assert.deepEqual(detail.appIDs, [`${TEAM_ID}.${BUNDLE_ID}`]);
  assert.notEqual(TEAM_ID, TEAM_ID_PLACEHOLDER);
  assert.match(TEAM_ID, TEAM_ID_PATTERN);
});

test('the committed file is exactly what the generator produces', () => {
  assert.equal(committedAssociation(), renderAssociation());
});

test('every claimed route is claimed by the committed file', () => {
  const { claimed } = partitionRoutes();
  for (const route of claimed) {
    assert.ok(
      claims(sampleUrlFor(route)).length > 0,
      `${route} is classified as an app route but no component matches ${sampleUrlFor(route)}`
    );
  }
});

test('no public route is claimed by the committed file', () => {
  const { web } = partitionRoutes();
  for (const route of web) {
    assert.deepEqual(
      claims(sampleUrlFor(route)),
      [],
      `${route} must stay in the browser but is matched by a component`
    );
  }
});

test('/account-deletion stays in the browser, next door to /account', () => {
  // Called out on its own because it is the one App Review reads, and because
  // the two paths differ by a suffix rather than by a segment: a `/account*`
  // typo claims both and nothing else in this file would notice.
  assert.ok(declaredRoutePaths().includes('/account-deletion'));
  assert.deepEqual(claims('/account-deletion'), []);
  assert.deepEqual(claims('/account'), ['/account']);
});

test('a prefix pattern replaces its children rather than sitting beside them', () => {
  // `/plants/new`, `/plants/import` and `/household/caretaker-report` are each
  // one segment below a claimed prefix, so they are covered without being
  // restated. `/sit/:token/brief` is two, so it is restated.
  assert.ok(!patterns.includes('/plants/new'));
  assert.ok(!patterns.includes('/plants/import'));
  assert.ok(!patterns.includes('/household/caretaker-report'));
  assert.ok(patterns.includes('/plants/*'));
  assert.ok(patterns.includes('/household/*'));
  assert.ok(patterns.includes('/sit/*/brief'));
  assert.deepEqual(componentPatterns(), patterns);
});

test('no component is an exclusion, so ordering cannot change the answer', () => {
  // Apple applies the first matching component and stops. This file claims by
  // enumeration only, so order is irrelevant — which is what lets the two
  // checks above reason about each pattern independently.
  for (const component of detail.components) {
    assert.equal(component.exclude, undefined);
  }
});
