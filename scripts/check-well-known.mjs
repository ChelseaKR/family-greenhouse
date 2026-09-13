#!/usr/bin/env node
/**
 * The deep-link association files must survive the deploy path (#469 §2).
 *
 * ## The failure this exists to prevent
 *
 * `/.well-known/assetlinks.json` and `/.well-known/apple-app-site-association`
 * are the two documents that let an installed app claim its own domain's
 * links. `apple-app-site-association` is now in the tree;
 * `assetlinks.json` is not, because the Android half still needs the release
 * keystore's SHA-256 fingerprint. Either way the deploy path has to carry
 * them, and until this gate existed it would not have. Three separate ways,
 * none of which reports an error:
 *
 *   1. The immutable asset sync in both CD workflows and `scripts/deploy.sh`
 *      excludes `*.json`, and the second sync is `--exclude "*" --include
 *      "*.html"`. So `assetlinks.json` is claimed by NEITHER sync. It never
 *      reaches the bucket, the deploy is green, and Android's verifier fetches
 *      a URL that was never uploaded.
 *
 *   2. `apple-app-site-association` is extensionless, so it matched no exclude
 *      at all and rode the immutable sync up with `max-age=31536000` and a
 *      guessed `binary/octet-stream`. Apple requires `application/json`, and a
 *      one-year immutable cache is the wrong lifetime for the one file you
 *      edit when a signing certificate changes.
 *
 *   3. The CloudFront viewer-request function rewrites any extensionless path
 *      to `/app-shell.html` by name. `apple-app-site-association` is
 *      extensionless, so Apple's CDN would have been served `200 text/html` no
 *      matter what the deploy uploaded — the file correctly typed, correctly
 *      cached, and unreachable.
 *
 * Every one of those is silent, and the symptom lands weeks later on a device,
 * as a verification failure with no server-side trace. So the wiring is
 * asserted here rather than discovered there.
 *
 * ## Why it checks in both directions
 *
 * The obvious gate — "if the file exists, make sure it is uploaded" — passes
 * trivially today and would pass just as trivially if someone deleted the
 * upload steps tomorrow, because there is still no file. So the wiring is
 * asserted UNCONDITIONALLY: the excludes, the guarded uploads with their
 * headers, and the router passthrough must all be present whether or not an
 * association file is in the tree. Same reasoning as the `expectedMatches`
 * count in `check-doc-figures.mjs` — a check satisfied by deleting its subject
 * is a check that quietly stopped checking.
 *
 * What the presence of a file adds is the content assertions: it must be one
 * of the two names the deploy path actually names (with `.well-known/*` now
 * excluded from the generic sync, an unrecognised file there is uploaded by
 * nothing at all), and it must be valid JSON — both formats are JSON, and
 * Apple's is JSON despite having no extension.
 *
 * ## The one thing it asserts about content: no placeholder Team ID ships
 *
 * An `appID` is `<Apple Team ID>.<bundle id>`. A Team ID that is not a Team ID
 * is the worst possible defect this file can carry, because every layer below
 * it reports success: the JSON parses, the deploy uploads it, S3 serves it as
 * `application/json`, Apple's CDN fetches it happily — and every universal
 * link silently keeps opening Safari. There is no server-side trace and the
 * feedback loop is weeks long and lands on someone else's device. It is this
 * repository's own "absence rendered as a value" defect at the layer where it
 * is least visible.
 *
 * So `appleAppIdProblems()` refuses, on every gate run and in CI:
 *
 *   - the `TEAMID_PENDING` sentinel;
 *   - a missing, empty, or non-string `appIDs` entry;
 *   - anything that is not exactly ten uppercase alphanumerics before the
 *     bundle identifier — a truncated paste, a lower-cased value, or the
 *     Enrollment ID, which is a different number that looks like a Team ID.
 *
 * The sentinel is still named even though the real Team ID has landed. The
 * failure it guards is a FUTURE placeholder — pasted in while standing up a
 * second app or a staging domain, then forgotten — which is exactly when a
 * sentinel gets committed. A gate retired the moment its first instance is
 * fixed is a gate that only ever caught the bug someone already knew about.
 *
 * The three deploy paths carry the same refusal inline, and it is asserted
 * here unconditionally, for the reason the whole file exists: CI is not the
 * last thing that can publish this object. `scripts/deploy.sh` is run by hand.
 *
 * ## What it deliberately does not check
 *
 * Nothing here asserts that a fingerprint is correct, that a Team ID of the
 * right SHAPE is the right team, or that the app-side half exists. Half a
 * deep-link setup is worse than none — an `intent-filter` with
 * `autoVerify="true"` and no matching `assetlinks.json` fails verification on
 * Android 12+ — so this gate covers the serving side only, which is the half
 * the repository can be right about on its own. Whether the Apple file's
 * CLAIM matches the app's route table is `aasa:check`
 * (frontend/scripts/build-app-site-association.mjs). See docs/mobile.md.
 *
 * This script reads. It never edits a workflow to match.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import {
  BUNDLE_ID,
  TEAM_ID_PATTERN,
  TEAM_ID_PLACEHOLDER,
} from '../frontend/scripts/app-site-association.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The two well-known URIs the deploy path names explicitly. Both are JSON;
 * Apple's is extensionless, which is the whole reason for half the rules here.
 */
const ASSOCIATION_FILES = ['assetlinks.json', 'apple-app-site-association'];

/** The one of the two whose `appID` names an Apple Team ID. */
const APPLE_ASSOCIATION = 'apple-app-site-association';

/** Where an association file would be committed, to be copied into `dist/`. */
const PUBLIC_WELL_KNOWN = 'frontend/public/.well-known';

/**
 * Where the real Team ID comes from, said the same way everywhere it is said.
 * Spelled out because the value has a convincing look-alike: the Enrollment ID
 * shown while an application is pending is NOT a Team ID, and a file carrying
 * one would parse, deploy, and fail verification silently.
 */
const TEAM_ID_SOURCE =
  'The real value is at Apple Developer → Membership → Team ID: exactly 10 uppercase ' +
  'alphanumeric characters, issued once a Developer Program enrollment is approved. It is ' +
  'NOT the Enrollment ID, which is a different number of a similar shape shown while an ' +
  'application is pending. Set it as TEAM_ID in frontend/scripts/app-site-association.mjs ' +
  'and run `npm run aasa --workspace frontend` to regenerate the file — it is generated, so ' +
  'hand-editing the appID is itself refused by `npm run aasa:check`.';

/**
 * Every path that uploads `frontend/dist` to the frontend bucket, with the
 * directory each one calls it. `scripts/deploy.sh` runs from the repo root and
 * says `frontend/dist`; the workflows run in the artifact directory and say
 * `dist`. All three are listed because the script has drifted from the
 * workflows before — the last time it did, every prerendered page went up with
 * a one-year immutable cache (#644).
 */
const DEPLOY_PATHS = [
  { file: '.github/workflows/cd-production.yml', dist: 'dist' },
  { file: '.github/workflows/cd-staging.yml', dist: 'dist' },
  { file: 'scripts/deploy.sh', dist: 'frontend/dist' },
];

/** The filter that keeps the immutable sync off `.well-known/`. */
const WELL_KNOWN_EXCLUDE = '--exclude ".well-known/*"';

/** The 1-year cache that marks the immutable asset sync. */
const IMMUTABLE_MAX_AGE = 'max-age=31536000';

/**
 * Longest cache an association file may be served with. These change exactly
 * when a signing certificate or Team ID changes, and both platforms re-fetch
 * on their own schedule — a long edge cache means verification keeps failing
 * for a correction that has already shipped.
 */
const MAX_CACHE_SECONDS = 300;

/** The CloudFront viewer-request function, which decides the whole routing. */
const ROUTER = 'infrastructure/modules/frontend/functions/spa-router.js';

const problems = [];

function read(relative) {
  return readFileSync(join(ROOT, relative), 'utf8');
}

/**
 * The runnable commands in a shell/workflow file, as logical lines.
 *
 * Comments are dropped first — every file below explains these rules in prose
 * that quotes the very strings being searched for, so a raw substring search
 * would be satisfied by the comment describing the upload rather than by the
 * upload. Then backslash continuations are joined, so a multi-line `aws s3 cp`
 * is matched as the single command it is.
 */
function commandLines(text) {
  const lines = text.split('\n').filter((line) => !line.trimStart().startsWith('#'));
  const joined = [];
  let pending = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.endsWith('\\')) {
      pending += `${trimmed.slice(0, -1).trim()} `;
      continue;
    }
    joined.push(`${pending}${trimmed}`.trim());
    pending = '';
  }
  if (pending) joined.push(pending.trim());
  return joined.filter(Boolean);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The Apple file's `appID`s, checked for the one thing that makes the file
 * unshippable rather than merely wrong: a Team ID that is not a Team ID.
 *
 * Every appID has to be `<10-character Team ID>.<bundle id>`. The placeholder
 * is called out by name because it is the expected state of this repository
 * until enrollment completes, and the failure text has to be a handover note
 * rather than a riddle. Anything else that fails the shape gets the same
 * refusal — a truncated paste, a lower-cased value, or the Enrollment ID,
 * which is the mistake this specific gate exists to catch.
 *
 * Deliberately NOT a check that the Team ID is the RIGHT one: nothing in this
 * repository can know that. The claim being made is narrower and provable —
 * that no value of a shape Apple never issues reaches the bucket.
 */
function appleAppIdProblems(parsed) {
  const where = `${PUBLIC_WELL_KNOWN}/${APPLE_ASSOCIATION}`;
  const appIds = parsed?.applinks?.details?.[0]?.appIDs;

  if (!Array.isArray(appIds) || appIds.length === 0) {
    return [
      `${where}: applinks.details[0].appIDs is missing or empty. Without it the file claims ` +
        'nothing for anyone, and iOS reports no error — it simply never associates the domain.',
    ];
  }

  const found = [];
  for (const appId of appIds) {
    if (typeof appId !== 'string' || !appId.endsWith(`.${BUNDLE_ID}`)) {
      found.push(
        `${where}: appID ${JSON.stringify(appId)} does not end in ".${BUNDLE_ID}", the bundle ` +
          'identifier the apps are built with (frontend/capacitor.config.ts, docs/mobile.md).'
      );
      continue;
    }
    const teamId = appId.slice(0, appId.length - BUNDLE_ID.length - 1);
    if (teamId === TEAM_ID_PLACEHOLDER) {
      found.push(
        `${where}: the appID carries the placeholder Team ID \`${TEAM_ID_PLACEHOLDER}\`, so ` +
          'this file CANNOT SHIP. Published as-is it parses, uploads, caches, and is fetched ' +
          'successfully by Apple — and every universal link silently keeps opening Safari, ' +
          `which is a failure with no server-side trace and a weeks-long feedback loop. ` +
          TEAM_ID_SOURCE
      );
      continue;
    }
    if (!TEAM_ID_PATTERN.test(teamId)) {
      found.push(
        `${where}: appID ${JSON.stringify(appId)} does not start with an Apple Team ID — ` +
          `\`${teamId}\` is not ${TEAM_ID_PATTERN.source}. ${TEAM_ID_SOURCE}`
      );
    }
  }
  return found;
}

// --- The deploy paths -------------------------------------------------------

for (const { file, dist } of DEPLOY_PATHS) {
  const text = read(file);
  const commands = commandLines(text);

  // The immutable sync must not claim `.well-known/`. Without this the
  // extensionless Apple file rides it up with a 1-year immutable cache and a
  // guessed content type, and the explicit upload below is a coin flip over
  // which one wrote the object last.
  const immutableSyncs = commands.filter(
    (line) => line.includes('aws s3 sync') && line.includes(IMMUTABLE_MAX_AGE)
  );
  if (immutableSyncs.length === 0) {
    problems.push(
      `${file}: no immutable asset sync found (an \`aws s3 sync\` carrying ` +
        `${IMMUTABLE_MAX_AGE}). This gate cannot tell whether \`.well-known/\` is ` +
        `excluded from a sync it cannot find — update this gate in the same change ` +
        `that moved the sync.`
    );
  }
  for (const sync of immutableSyncs) {
    if (!sync.includes(WELL_KNOWN_EXCLUDE)) {
      problems.push(
        `${file}: the immutable asset sync does not carry \`${WELL_KNOWN_EXCLUDE}\`. ` +
          `\`apple-app-site-association\` is extensionless, so it matches none of the ` +
          `other excludes and would be uploaded with max-age=31536000 and a guessed ` +
          `binary/octet-stream content type. Add the exclude next to the robots.txt one.`
      );
    }
  }

  for (const name of ASSOCIATION_FILES) {
    const source = `${dist}/.well-known/${name}`;

    // Conditional, because the files do not exist yet. An unguarded `aws s3 cp`
    // of a missing file fails the step, and this deploy path runs on every
    // release.
    const guard = new RegExp(`if\\s+\\[\\[?\\s+-f\\s+"?${escapeRegExp(source)}"?\\s+\\]\\]?;`);
    if (!guard.test(text)) {
      problems.push(
        `${file}: no \`if [ -f ${source} ]\` guard. The upload has to be conditional — ` +
          `the association files are not in the tree yet, and an unguarded copy of a ` +
          `missing file fails every deploy.`
      );
    }

    const uploads = commands.filter((line) => line.includes('aws s3 cp') && line.includes(source));
    if (uploads.length !== 1) {
      problems.push(
        `${file}: expected exactly 1 \`aws s3 cp ${source}\` command, found ${uploads.length}. ` +
          `Nothing else uploads it: \`assetlinks.json\` is excluded from the immutable sync ` +
          `by \`*.json\` and is not \`*.html\`, so with no explicit copy it never reaches ` +
          `the bucket and the deploy still reports success.`
      );
      continue;
    }

    const [upload] = uploads;
    if (!upload.includes(`/.well-known/${name}`) || !upload.includes('s3://')) {
      problems.push(
        `${file}: the upload of ${source} does not target ` +
          `\`s3://<bucket>/.well-known/${name}\`. The key has to match the URL both ` +
          `platforms fetch.`
      );
    }
    if (!/--content-type\s+"?application\/json"?/.test(upload)) {
      problems.push(
        `${file}: the upload of ${source} does not set ` +
          `\`--content-type "application/json"\`. S3 guesses \`binary/octet-stream\` for ` +
          `an extensionless key, and Apple rejects an association file that is not served ` +
          `as application/json.`
      );
    }
    // The placeholder refusal. Asserted for the Apple file in every deploy
    // path, present or absent, because a deploy is the last thing that can
    // publish this object and `scripts/deploy.sh` is run by hand without CI.
    // Both halves are required: a `grep` whose failure nobody acts on is a
    // gate that cannot fail.
    if (name === APPLE_ASSOCIATION) {
      const refusalAt = commands.findIndex(
        (line) =>
          line.includes('grep') && line.includes(TEAM_ID_PLACEHOLDER) && line.includes(source)
      );
      if (refusalAt === -1) {
        problems.push(
          `${file}: nothing refuses to publish ${source} when it carries the placeholder Team ` +
            `ID \`${TEAM_ID_PLACEHOLDER}\`. Add a guard that greps the file for the sentinel ` +
            `and exits 1 before the upload. ${TEAM_ID_SOURCE}`
        );
      } else if (
        !commands.slice(refusalAt + 1, refusalAt + 6).some((line) => /^exit 1$/.test(line))
      ) {
        problems.push(
          `${file}: the \`${TEAM_ID_PLACEHOLDER}\` grep over ${source} is not followed by an ` +
            `\`exit 1\`, so it reports the placeholder and publishes it anyway. A check whose ` +
            'failure nothing acts on is a check that cannot fail.'
        );
      }
    }

    const maxAge = upload.match(/--cache-control\s+"?max-age=(\d+)/);
    if (!maxAge) {
      problems.push(
        `${file}: the upload of ${source} sets no \`--cache-control "max-age=..."\`, so it ` +
          `inherits whatever the bucket default is. Use max-age=${MAX_CACHE_SECONDS}.`
      );
    } else if (Number(maxAge[1]) > MAX_CACHE_SECONDS) {
      problems.push(
        `${file}: the upload of ${source} caches for ${maxAge[1]}s; the ceiling is ` +
          `${MAX_CACHE_SECONDS}s. This file changes when a signing certificate or Team ID ` +
          `changes, and a long edge cache keeps verification failing for a fix that has ` +
          `already shipped.`
      );
    }
  }
}

// --- The CloudFront viewer-request function ---------------------------------
// Read the way CloudFront reads it — by evaluating it — for the same reason
// build-spa-router.mjs does: a rule that parses but is unreachable, shadowed or
// commented out passes a textual diff and fails in production.

const routerSandbox = {};
try {
  runInNewContext(read(ROUTER), routerSandbox, { filename: 'spa-router.js' });
} catch (error) {
  problems.push(`${ROUTER}: does not evaluate (${error.message}).`);
}

if (typeof routerSandbox.handler === 'function') {
  for (const name of ASSOCIATION_FILES) {
    const uri = `/.well-known/${name}`;
    const routed = routerSandbox.handler({ request: { uri } }).uri;
    if (routed !== uri) {
      problems.push(
        `${ROUTER}: rewrites ${uri} to ${routed}. An association file served as the app ` +
          `shell is a 200 of text/html to Apple and to Android's verifier, whatever the ` +
          `deploy uploaded — and a MISSING one becomes a parse error instead of an honest ` +
          `404. Restore the \`/.well-known/\` passthrough next to the \`/assets/\` one.`
      );
    }
  }
} else if (problems.length === 0) {
  problems.push(`${ROUTER}: defines no \`handler\` function.`);
}

// --- The files themselves, if any have landed -------------------------------

if (existsSync(join(ROOT, PUBLIC_WELL_KNOWN))) {
  const present = readdirSync(join(ROOT, PUBLIC_WELL_KNOWN), { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);

  for (const name of present) {
    if (!ASSOCIATION_FILES.includes(name)) {
      problems.push(
        `${PUBLIC_WELL_KNOWN}/${name}: no deploy path uploads this file. The immutable ` +
          `sync now excludes \`.well-known/*\` and the explicit uploads name only ` +
          `${ASSOCIATION_FILES.join(' and ')}, so this would be built into dist/ and ` +
          `never reach the bucket. Add it to ASSOCIATION_FILES here and to the upload ` +
          `steps in ${DEPLOY_PATHS.map((p) => p.file).join(', ')}.`
      );
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(read(`${PUBLIC_WELL_KNOWN}/${name}`));
    } catch (error) {
      problems.push(
        `${PUBLIC_WELL_KNOWN}/${name}: is not valid JSON (${error.message}). It is served ` +
          `as application/json${name.includes('.') ? '' : ' despite having no extension'}, ` +
          `and both platforms fail verification on a parse error.`
      );
      continue;
    }

    if (name === APPLE_ASSOCIATION) {
      problems.push(...appleAppIdProblems(parsed));
    }
  }
}

// --- Report -----------------------------------------------------------------

if (problems.length > 0) {
  console.error('\n❌ The deep-link association files are not fit to deploy:\n');
  for (const problem of problems) console.error(`   ${problem}`);
  console.error('\nFix the deploy path or the file, not this gate. Background: docs/mobile.md.');
  process.exit(1);
}

const landed = existsSync(join(ROOT, PUBLIC_WELL_KNOWN))
  ? readdirSync(join(ROOT, PUBLIC_WELL_KNOWN)).length
  : 0;
console.log(
  `well-known:check OK — ${DEPLOY_PATHS.length} deploy paths upload ` +
    `${ASSOCIATION_FILES.length} association files as application/json with a ` +
    `≤${MAX_CACHE_SECONDS}s cache, the immutable sync excludes .well-known/, and the ` +
    `CloudFront router serves them rather than the app shell ` +
    `(${landed} file(s) currently in ${PUBLIC_WELL_KNOWN}).`
);
