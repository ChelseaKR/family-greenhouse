#!/usr/bin/env node
/**
 * Generate — and, with `--check`, verify — the iOS association file at
 * `frontend/public/.well-known/apple-app-site-association`.
 *
 * Same shape and the same reasoning as `build-spa-router.mjs`: the artifact is
 * committed (the deploy uploads a file, not a build step's opinion), it is
 * derived from `App.tsx` so it cannot drift from the routes React Router
 * matches, and the `--check` mode WRITES NOTHING. A gate that repairs the
 * artifact it is judging heals drift on the contributor's disk while the
 * committed bytes — the ones Apple fetches — stay stale.
 *
 * `--check` asserts four things, and the last two are asserted against the
 * COMMITTED components rather than against freshly generated ones. Comparing
 * the generator with itself proves nothing; the file on disk is what deploys.
 *
 *   1. Every route App.tsx declares is classified in ROUTE_POLICY, and every
 *      classified route still exists.
 *   2. The committed bytes are exactly what the generator produces, Team ID
 *      included. TEAM_ID is a constant in app-site-association.mjs, so the
 *      file cannot be hand-edited into disagreeing with it — and a hand-edited
 *      Team ID is precisely how a wrong one would get published.
 *   3. Every claimed route is matched by at least one committed component —
 *      so deleting a claim fails here rather than on a device.
 *   4. NO route classified `web` is matched by any committed component. This
 *      is the assertion that matters: `/account` and `/account-deletion` are
 *      one `*` apart, and a deletion route that opens the app strands exactly
 *      the person who cannot sign in.
 *
 * What it does NOT check is the Team ID itself — that is
 * `scripts/check-well-known.mjs`, which owns everything about whether the
 * association files can actually ship.
 *
 * Usage:
 *   node scripts/build-app-site-association.mjs           # write the file
 *   node scripts/build-app-site-association.mjs --check   # verify, write nothing
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';

import { declaredRoutePaths, sampleUrlFor } from './app-routes.mjs';
import {
  ASSOCIATION_PATH,
  BUNDLE_ID,
  TEAM_ID,
  committedAssociation,
  matchesComponent,
  partitionRoutes,
  renderAssociation,
} from './app-site-association.mjs';

const REL = 'frontend/public/.well-known/apple-app-site-association';

/** The `/` patterns the committed file actually declares. */
function committedComponents(source) {
  const parsed = JSON.parse(source);
  const details = parsed?.applinks?.details;
  if (!Array.isArray(details) || details.length !== 1) {
    throw new Error(`${REL}: expected exactly one entry in applinks.details.`);
  }
  const { appIDs, components } = details[0];
  if (!Array.isArray(appIDs) || appIDs.length !== 1) {
    throw new Error(`${REL}: expected exactly one appID.`);
  }
  if (!Array.isArray(components)) {
    throw new Error(`${REL}: applinks.details[0].components is not an array.`);
  }
  for (const component of components) {
    if (typeof component?.['/'] !== 'string') {
      throw new Error(`${REL}: a component has no string \`/\` pattern.`);
    }
    if (component.exclude === true) {
      throw new Error(
        `${REL}: a component sets \`exclude: true\`. This file claims by enumeration — a path ` +
          'that is not listed is already not claimed — so an exclusion here would be the only ' +
          'thing standing between a wildcard and a public page, and the claim/exclusion checks ' +
          'below would have to model Apple’s first-match-wins ordering to stay honest.'
      );
    }
  }
  return { appId: appIDs[0], patterns: components.map((component) => component['/']) };
}

function check() {
  const declared = declaredRoutePaths();
  const problems = [];

  // (1) + the generator's own route/policy assertions.
  let expected;
  try {
    expected = renderAssociation(TEAM_ID, declared);
  } catch (error) {
    console.error(`\n❌ aasa:check: ${error.message}\n`);
    return 1;
  }

  const actual = committedAssociation();
  if (actual === null) {
    console.error(
      `\n❌ aasa:check: ${REL} is missing.\n\n` +
        '   Without it every link this product mails — sitter invites, caretaker reports,\n' +
        '   the reminder link — opens the browser and asks a signed-in user to sign in again.\n' +
        `   Regenerate it: npm run aasa --workspace frontend\n`
    );
    return 1;
  }

  // (2) drift.
  if (actual !== expected) {
    console.error(
      `\n❌ aasa:check: ${REL} is not what the generator produces from App.tsx.\n\n` +
        '   The association file is a second copy of the route table, and every second copy\n' +
        '   in this repo has drifted (#615, #719, #721). Regenerate rather than hand-edit:\n' +
        '     npm run aasa --workspace frontend\n' +
        '   If the change you want is a different CLAIM, edit ROUTE_POLICY in\n' +
        '   frontend/scripts/app-site-association.mjs and regenerate.\n'
    );
    return 1;
  }

  let committed;
  try {
    committed = committedComponents(actual);
  } catch (error) {
    console.error(`\n❌ aasa:check: ${error.message}\n`);
    return 1;
  }

  const { claimed, web } = partitionRoutes(declared);

  // (3) every claimed route is really claimed.
  for (const route of claimed) {
    const url = sampleUrlFor(route);
    if (!committed.patterns.some((pattern) => matchesComponent(pattern, url))) {
      problems.push(
        `${route} is classified as an app route but no component in ${REL} matches ${url}. ` +
          'The app would not open that link; iOS would hand it to Safari.'
      );
    }
  }

  // (4) no public route is claimed by accident.
  for (const route of web) {
    const url = sampleUrlFor(route);
    const matching = committed.patterns.filter((pattern) => matchesComponent(pattern, url));
    if (matching.length > 0) {
      problems.push(
        `${route} must stay in the browser, but ${matching.join(', ')} in ${REL} matches ` +
          `${url}. A public entry point that opens the app is unreachable for anyone who has ` +
          'not installed it, and for /account-deletion it strands the person who cannot sign ' +
          'in — which is the case App Review checks.'
      );
    }
  }

  // The appID's bundle half is ours to be right about; the Team ID half is
  // checked by scripts/check-well-known.mjs, which owns shippability.
  if (!committed.appId.endsWith(`.${BUNDLE_ID}`)) {
    problems.push(
      `${REL}: appID "${committed.appId}" does not end in ".${BUNDLE_ID}", the bundle ` +
        'identifier in frontend/capacitor.config.ts and docs/mobile.md.'
    );
  }

  if (problems.length > 0) {
    console.error('\n❌ aasa:check: the iOS universal-link claim disagrees with App.tsx:\n');
    for (const problem of problems) console.error(`   ${problem}`);
    console.error(
      '\nThe claim lives in ROUTE_POLICY (frontend/scripts/app-site-association.mjs).\n'
    );
    return 1;
  }

  console.log(
    `aasa:check OK — ${claimed.length} of ${claimed.length + web.length} declared routes are ` +
      `claimed by ${committed.patterns.length} components, ${web.length} public routes are ` +
      `matched by none of them, and ${REL} is byte-identical to the generator's output.`
  );
  return 0;
}

function write() {
  const source = renderAssociation(TEAM_ID);
  mkdirSync(dirname(ASSOCIATION_PATH), { recursive: true });
  writeFileSync(ASSOCIATION_PATH, source);
  console.log(`wrote ${REL}`);
  return 0;
}

process.exit(process.argv.includes('--check') ? check() : write());
