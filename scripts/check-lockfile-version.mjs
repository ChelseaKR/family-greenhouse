#!/usr/bin/env node
/**
 * `package-lock.json` records the same version as the `package.json` files it
 * locks (#728).
 *
 * ## The drift this exists to prevent
 *
 * Every other place this repository states its version is already compared
 * against `package.json` by something:
 *
 * | file                                  | gate                                    |
 * | ------------------------------------- | --------------------------------------- |
 * | `frontend/package.json`               | `mobile:validate`                       |
 * | `backend/package.json`                | `mobile:validate`                       |
 * | `frontend/android/app/build.gradle`   | `mobile:validate`                       |
 * | `frontend/ios/.../project.pbxproj`    | `mobile:validate`                       |
 * | `CITATION.cff`                        | `citation:check`                        |
 * | `README.md` ("aligned at X")          | `figures:check`                         |
 * | the `v*` tag                          | `cd-production.yml` at the tagged ref   |
 *
 * `package-lock.json` was the one that was not, and it states the version in
 * **four** places: the top-level `version`, `packages[""].version`, and one
 * entry per workspace. A release that edits the three `package.json` files and
 * forgets `npm install --package-lock-only` leaves all four a release behind.
 *
 * The reason that is not cosmetic is that the lockfile is the file the build
 * installs *from*. `npm ci` reads it, and the version it carries is what ends
 * up in the metadata of anything packed or published out of this tree — the
 * defect that shipped elsewhere in this portfolio as a wheel reporting `0.1.0`
 * under a tag that said `0.2.0`.
 *
 * ## Why npm does not already catch it
 *
 * It is tempting to assume `npm ci` refuses a lockfile that disagrees with its
 * `package.json`. It refuses one whose *dependency* tree disagrees; the root
 * `version` field is not part of that comparison. Measured before writing this
 * check, on a two-file fixture with `package.json` at `0.32.0` and the lock at
 * `0.31.0`: `npm ci` exits 0, prints no warning, and leaves the lockfile
 * saying `0.31.0`. There was no run to fail — the same shape as the
 * `CITATION.cff` drift in #685, which sat six minor versions stale for six
 * weeks because nothing compared the two numbers.
 *
 * The check is one-directional in the sense that matters: `package.json` is
 * the source and the lockfile must follow it. It never rewrites anything on
 * its own — the fix is `npm install --package-lock-only`, which regenerates
 * the lockfile from the manifests rather than patching four numbers by hand.
 *
 * Usage:
 *   node scripts/check-lockfile-version.mjs      # check (exit 1 on drift)
 */
import { readFileSync } from 'node:fs';

const LOCK = 'package-lock.json';
const ROOT = 'package.json';

/** How to put it right, named once so every message says the same thing. */
const REMEDY = 'Run `npm install --package-lock-only` and commit the result.';

/**
 * Compare the version every lockfile entry records against the `package.json`
 * that entry locks.
 *
 * `manifests` maps a workspace path (`''` for the root) to the version its
 * `package.json` declares. `lock` is the parsed lockfile.
 *
 * Returns a list of human-readable failures; empty means agreement.
 */
export function evaluate({ manifests, lock }) {
  const failures = [];
  const rootVersion = manifests[''];

  // A lockfile with no `packages` map is lockfileVersion 1, or truncated.
  // Either way the per-workspace comparison below silently checks nothing, so
  // say so rather than passing over an empty object — a comparison against
  // nothing is this repository's named "gate that cannot fail" shape.
  if (lock.packages === undefined || lock.packages === null) {
    failures.push(
      `${LOCK} has no \`packages\` map (lockfileVersion ${lock.lockfileVersion ?? '?'}). ` +
        `There is nothing to compare the workspace versions against, so this check would ` +
        `pass over an empty set. ${REMEDY}`
    );
    return failures;
  }

  // 1. The lockfile's own top-level `version`.
  if (lock.version === undefined) {
    failures.push(`${LOCK} has no top-level \`version\` field. ${REMEDY}`);
  } else if (lock.version !== rootVersion) {
    failures.push(
      `${LOCK} top-level \`version\` is ${lock.version}; ${ROOT} says ${rootVersion}. ` +
        `The lockfile is what \`npm ci\` installs from, so a build out of this tree would ` +
        `report the wrong version. ${REMEDY}`
    );
  }

  // 2. Every entry whose manifest we know about — the root (`""`) and each
  //    declared workspace. A workspace present in package.json but absent from
  //    the lockfile is a failure, not a skip: skipping is how a missing entry
  //    reads as agreement.
  for (const [path, manifestVersion] of Object.entries(manifests)) {
    const entry = lock.packages[path];
    const label = path === '' ? 'root entry `""`' : `workspace \`${path}\``;
    if (entry === undefined) {
      failures.push(`${LOCK} has no entry for ${label}, which ${ROOT} declares. ${REMEDY}`);
      continue;
    }
    if (entry.version === undefined) {
      failures.push(
        `${LOCK}'s ${label} records no \`version\`. An absent version is not an agreeing ` +
          `one. ${REMEDY}`
      );
      continue;
    }
    if (entry.version !== manifestVersion) {
      failures.push(
        `${LOCK}'s ${label} says ${entry.version}; ${path === '' ? ROOT : `${path}/package.json`} ` +
          `says ${manifestVersion}. ${REMEDY}`
      );
    }
  }

  return failures;
}

/** Read the root manifest and each workspace it declares. */
export function readManifests(read = (p) => readFileSync(p, 'utf8')) {
  const root = JSON.parse(read(ROOT));
  const manifests = { '': root.version };
  for (const workspace of root.workspaces ?? []) {
    manifests[workspace] = JSON.parse(read(`${workspace}/package.json`)).version;
  }
  return manifests;
}

function main() {
  const manifests = readManifests();
  if (typeof manifests[''] !== 'string' || manifests[''] === '') {
    console.error(`${ROOT} has no \`version\`; there is nothing to compare against.`);
    return 1;
  }
  const lock = JSON.parse(readFileSync(LOCK, 'utf8'));

  const failures = evaluate({ manifests, lock });
  if (failures.length > 0) {
    console.error('Lockfile version check FAILED:\n');
    for (const failure of failures) console.error(`  - ${failure}\n`);
    return 1;
  }

  const places = 1 + Object.keys(manifests).length;
  console.log(
    `${LOCK} records ${manifests['']} in all ${places} places, matching ${ROOT} and ` +
      `${Object.keys(manifests).length - 1} workspace manifests.`
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
