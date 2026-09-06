#!/usr/bin/env node
/**
 * A `v*` tag here is a production deployment. Assert that each one leaves a
 * record of what shipped.
 *
 * ## What was measured on 2026-09-06
 *
 * 46 tags. 8 GitHub Releases. `cd-production.yml` triggers on `push: tags:
 * ['v*']`, and every tag has a run: 39 of the 46 reached a successful
 * production deploy. Thirty-two of those 39 have no GitHub Release, so the only
 * public record that they shipped is a workflow run that ages out of the
 * Actions UI. The full table and the per-tag deploy outcomes are in
 * `docs/release-record-gap.md`.
 *
 * The gap is drift, not a policy of curating releases:
 *
 *   - `docs/standards/RELEASE-AND-VERSIONING-STANDARD.md` §4 step 7 and §6
 *     require a GitHub Release per release, carrying the SBOM, the provenance
 *     attestation and the CHANGELOG section as its notes. No exception to that
 *     is declared anywhere in this repo.
 *   - The first six tags (v0.2.0 through v0.7.0) each got one. The practice
 *     lapsed after 2026-06-17; the two later releases (v0.16.2, v0.20.0) are
 *     sporadic rather than selective.
 *   - Nothing automates release creation, and `docs/deployment.md`'s promotion
 *     procedure ended at `git push origin v1.2.3`.
 *   - `cd-production.yml`'s REL-10 step already refuses a tag whose version has
 *     no `## [X.Y.Z]` CHANGELOG section, so the release notes for all 38 exist
 *     and are written. Only the release object is missing. That is the shape of
 *     an omitted step, not of a decision.
 *
 * The inverse defect is here too, and it is why "count the releases" would not
 * have been enough: **v0.3.0 has a GitHub Release and both of its production
 * deploys failed.** The only public record says it shipped. The run history
 * says it did not.
 *
 * ## What this gate does, and what it deliberately does not
 *
 * It cannot create the 38 missing records — publishing a release is an owner
 * action. What it does is stop the gap growing without anyone noticing: a tag
 * that is not in `.github/release-record-baseline.txt` and has no release after
 * the grace period fails. The baseline is a debt register, so the only correct
 * edit to it is a deletion once a release is published.
 *
 * It fails in both directions, the property `check-doc-figures.mjs` argues for:
 * a new unrecorded tag fails, and so does a baseline entry naming a tag that
 * does not exist, which is how a baseline turns into scaffolding.
 *
 * ## Usage
 *
 *   node scripts/check-release-record.mjs --releases releases.json
 *   node scripts/check-release-record.mjs --releases releases.json --print
 *   node scripts/check-release-record.mjs --releases r.json --expect-failure
 *
 * `--releases` is the GitHub API's `/repos/{owner}/{repo}/releases` array. The
 * network call belongs to the caller (`.github/workflows/release-record.yml`)
 * so that everything below is a pure function of files on disk and can be
 * tested without one.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_BASELINE = '.github/release-record-baseline.txt';
export const DEFAULT_GRACE_DAYS = 7;

const SEMVER_TAG = /^v\d+\.\d+\.\d+$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @typedef {object} TagRecord
 * @property {string} name
 * @property {string} date ISO-8601 date the tag was created.
 */

/** Read the baseline, dropping comments and blank lines. */
export function parseBaseline(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/** Tag names of published (non-draft) releases. */
export function publishedReleaseTags(releases) {
  return new Set(releases.filter((release) => release.draft !== true).map((r) => r.tag_name));
}

/**
 * The whole verdict, as data. Pure: no clock, no network, no filesystem.
 *
 * @param {object} input
 * @param {TagRecord[]} input.tags        every `v*` tag and when it was made
 * @param {Set<string>} input.released    tags that have a published release
 * @param {string[]}    input.baseline    tags already known to have no record
 * @param {Date}        input.now
 * @param {number}      input.graceDays
 */
export function evaluate({ tags, released, baseline, now, graceDays }) {
  const baselineSet = new Set(baseline);
  const tagNames = new Set(tags.map((tag) => tag.name));

  const unrecorded = tags.filter((tag) => !released.has(tag.name));

  // A tag that nobody has recorded and that the baseline does not account for.
  // The grace period is what makes this usable: a release is published by hand
  // some time after the tag is pushed, so failing on the day of the tag would
  // only teach people to ignore the check.
  const overdue = unrecorded
    .filter((tag) => !baselineSet.has(tag.name))
    .filter((tag) => now.getTime() - Date.parse(tag.date) >= graceDays * DAY_MS);

  // Named in the baseline, not a tag in this repository. A baseline that has
  // stopped matching reality is scaffolding, and scaffolding is where a real
  // gap hides.
  const phantom = baseline.filter((name) => !tagNames.has(name));

  // Named in the baseline and since released. Not a failure — this is the debt
  // being paid — but the line should go, or the register overstates what is owed.
  const resolved = baseline.filter((name) => released.has(name));

  return {
    tagCount: tags.length,
    releasedCount: tags.filter((tag) => released.has(tag.name)).length,
    unrecorded: unrecorded.map((tag) => tag.name),
    overdue: overdue.map((tag) => tag.name),
    phantom,
    resolved,
    ok: overdue.length === 0 && phantom.length === 0,
  };
}

/** Every `v*.*.*` tag in the checkout, with its creation date. */
export function gitTags(cwd = ROOT) {
  const out = execFileSync(
    'git',
    ['for-each-ref', '--format=%(refname:short)\t%(creatordate:iso-strict)', 'refs/tags'],
    { cwd, encoding: 'utf8' }
  );
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, date] = line.split('\t');
      return { name, date };
    })
    .filter((tag) => SEMVER_TAG.test(tag.name));
}

export function report(result, { graceDays }) {
  const lines = [
    `tags: ${result.tagCount}`,
    `with a published GitHub Release: ${result.releasedCount}`,
    `without one: ${result.unrecorded.length}, of which ${result.overdue.length} are overdue and unaccounted for`,
  ];
  if (result.resolved.length > 0) {
    lines.push(
      '',
      'Baseline entries that now have a release. Delete these lines from ' +
        `${DEFAULT_BASELINE}: ${result.resolved.join(', ')}`
    );
  }
  if (result.phantom.length > 0) {
    lines.push(
      '',
      `${DEFAULT_BASELINE} names tags that do not exist: ${result.phantom.join(', ')}`
    );
  }
  if (result.overdue.length > 0) {
    lines.push(
      '',
      `These tags deployed to production more than ${graceDays} days ago and have ` +
        `no GitHub Release: ${result.overdue.join(', ')}`,
      '',
      'A tag here is a deployment. Publish the release with the CHANGELOG section ' +
        'as its notes (RELEASE-AND-VERSIONING-STANDARD §4, §6), or, if the tag ' +
        'genuinely shipped nothing, say so in docs/release-record-gap.md and add ' +
        'it to the baseline with that reason.'
    );
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const args = {
    releases: null,
    baseline: DEFAULT_BASELINE,
    graceDays: DEFAULT_GRACE_DAYS,
    expectFailure: false,
    print: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--releases') args.releases = argv[(i += 1)];
    else if (arg === '--baseline') args.baseline = argv[(i += 1)];
    else if (arg === '--grace-days') args.graceDays = Number(argv[(i += 1)]);
    else if (arg === '--expect-failure') args.expectFailure = true;
    else if (arg === '--print') args.print = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (args.releases === null) throw new Error('--releases <path to the releases JSON> is required');
  return args;
}

export function main(argv) {
  const args = parseArgs(argv);
  const releases = JSON.parse(readFileSync(args.releases, 'utf8'));
  const result = evaluate({
    tags: gitTags(),
    released: publishedReleaseTags(releases),
    baseline: parseBaseline(readFileSync(resolve(ROOT, args.baseline), 'utf8')),
    now: new Date(),
    graceDays: args.graceDays,
  });

  process.stdout.write(`${report(result, { graceDays: args.graceDays })}\n`);
  if (args.print) return 0;

  if (args.expectFailure) {
    // The negative control, run the same way uptime.yml runs its own: prove
    // the check can still fail before believing that it passed.
    if (result.ok) {
      process.stderr.write('Expected a failure and the check passed.\n');
      return 1;
    }
    process.stdout.write('Negative control: the check failed as required.\n');
    return 0;
  }
  return result.ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
