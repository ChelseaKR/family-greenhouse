#!/usr/bin/env node
/**
 * Is the site a visitor gets at familygreenhouse.net the site this repository has?
 *
 * Nothing in this repository asked that question before. `uptime.yml` runs every
 * fifteen minutes and proves the API answers and the pages render — it never reads
 * which commit produced them, so a site frozen three weeks behind `main` passes it
 * every single time. `cd-production.yml` fires on `push: tags: ['v*']` and on
 * nothing else, which is deliberate (a deploy costs money and needs a CHANGELOG
 * section), so a merge to `main` reaches no visitor until someone cuts a tag. A tag
 * nobody cuts and a deploy that was rolled back look identical from outside: the
 * live site simply stops moving while `main` keeps going.
 *
 * This module is the clock nobody was watching. It publishes nothing, holds no
 * credential that could, and does not read or set any publish-enable variable.
 *
 * ## Publishing model
 *
 * Own infrastructure (brief model 3): S3 + CloudFront for the frontend, Lambda +
 * API Gateway for the backend, all applied by `cd-production.yml` into the
 * `production` environment. Three of its jobs declare `environment: production` —
 * `Terraform Apply`, `Deploy Backend`, `Deploy Frontend` — so every release leaves
 * exactly three rows in `repos/:owner/:repo/deployments?environment=production`,
 * each naming the tagged commit.
 *
 * ## WHAT A ROLLED-BACK DEPLOY LOOKS LIKE IN THE DEPLOYMENT RECORD
 *
 * It looks exactly like a successful one. This is the single most important fact
 * about measuring this repository, and it is why the deployment record is not
 * trusted here on its own.
 *
 * `cd-production.yml` auto-rolls back on post-deploy smoke failure: the `rollback`
 * job fires on `always() && needs.smoke-tests.result != 'success'` and restores the
 * pre-deploy frontend snapshot from S3 (plus a CloudFront invalidation) and the
 * previous Lambda package for every function. Neither `smoke-tests` nor `rollback`
 * declares an `environment:`, so neither creates a deployment row and neither can
 * change one. By the time smoke runs, all three environment jobs have already
 * finished successfully and their three rows already say `success` at the tagged
 * commit. The rollback then quietly puts the previous release's bytes back and the
 * deployment record still reports the new tag as live. Measured on 2026-09-13
 * against every `production` deployment in this repository's history (100 rows) and
 * against the job lists of every `cd-production.yml` run: the `Auto-rollback
 * production release` job appears in six runs and owns zero deployment rows.
 *
 * The live API cannot see it either, and for a reason worth writing down. `GET
 * /health` returns `version: process.env.GIT_SHA`, and `GIT_SHA` is a Lambda
 * environment variable set by Terraform (`infrastructure/modules/api/main.tf`,
 * `GIT_SHA = var.git_sha`). The rollback restores Lambda *code* with
 * `update-function-code` and its only `terraform apply` is
 * `-target=module.auth.aws_cognito_user_pool.main`. Environment variables are never
 * reverted, so after a rollback `/health` keeps reporting the commit that was rolled
 * back away from while running the previous release's code.
 *
 * What does revert is the frontend. The rollback copies the pre-deploy snapshot back
 * over the bucket, deletes what the failed deploy added, and waits for the CloudFront
 * invalidation to complete. And the frontend carries a commit fingerprint a visitor
 * can fetch: `frontend/vite.config.ts` passes `VITE_GIT_SHA` to workbox as the
 * `app-shell.html` precache revision, so `https://familygreenhouse.net/sw.js`
 * contains `{revision:"<40-hex sha>",url:"app-shell.html"}`. Verified live on
 * 2026-09-13: the service worker reported `ea48db2b5cfbfdd6fdef92d7c08206c37ecd4c16`,
 * matching the newest `production` deployment and `/health`'s `version`.
 *
 * So this module takes the service worker's revision as the live commit — it is the
 * only one of the three signals that is made of the bytes a visitor actually
 * receives — and uses the deployment record to date it and to cross-check it. A
 * rollback then shows up as a disagreement: frontend on the older commit, `/health`
 * and the deployment record on the newer one. That disagreement is reported by name.
 *
 * ## Why the deployment record and not the workflow run history
 *
 * A run list cannot answer this. `cd-production.yml` has failed at eight different
 * tags and been re-run at a moved tag twice; counting successful runs would credit a
 * deploy to a release whose smoke test failed, and filtering them would leave gaps
 * that read as "never deployed". A deployment row exists because a publishing job
 * ran against the `production` environment, and it names the commit. That is the
 * only place the deploy *time* is written down, which is what this needs it for.
 *
 * Reading those rows has one subtlety measured here: GitHub auto-inactivates older
 * deployments when a newer one succeeds, so most historical rows have `inactive` as
 * their newest status with `success` behind it. `inactive` means "published, then
 * superseded" — refusing those would reject every row older than the current release
 * and leave the sentinel permanently unable to date anything. A row counts as
 * published when its status history contains `success` and its newest status is not
 * `failure` or `error`.
 *
 * ## Why the threshold is not "days since the last deploy"
 *
 * Deploys are tag-gated on purpose. Fourteen quiet days here mean nobody cut a
 * release, which is correct behaviour and not a defect, and `main` goes weeks
 * between releases when what merged was documentation. Age alone would fire on every
 * such week and the sentinel would be ignored inside a month.
 *
 * The honest signal is the wait of the *change*, not the age of the *build*: how
 * long has the oldest merged commit that a visitor would actually receive been
 * sitting unreleased. That clock starts when the commit lands, so a quiet month
 * costs nothing and a visitor-visible fix that sat for fifteen days is reported on
 * day fifteen whether or not anything else happened. `SITE_SOURCE` below is what
 * "a visitor would actually receive" means, and it is deliberately narrow.
 *
 * ## It must be able to fail
 *
 * Every case where the comparison cannot be made raises `StalenessUnknown` and exits
 * non-zero. No deployment; none that published; a service worker with no fingerprint
 * in it; a live commit this clone does not contain (the shallow-checkout case, which
 * silently reports zero drift); a live commit that is not an ancestor of `main`; a
 * live commit no deployment row accounts for. A detector that cannot tell has to
 * look broken rather than report a comfortable zero.
 *
 * The verdict itself is an issue, not a red run. A scheduled check that stays red
 * for a month because a release is overdue is a check nobody reads; the run goes red
 * only when the measurement could not be made at all.
 *
 * ## Usage
 *
 * The network belongs to the caller (`.github/workflows/deploy-staleness.yml`), the
 * same split `check-release-record.mjs` uses, so everything below is a pure function
 * of files on disk and is tested without one.
 *
 *   node scripts/check-deploy-staleness.mjs \
 *     --deployments deployments.json --statuses statuses.json \
 *     --service-worker sw.js --health health.json [--head origin/main] \
 *     [--max-age-days 14] [--json] [--expect-failure]
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Days an unreleased visitor-visible commit may wait before this reports. */
export const DEFAULT_MAX_AGE_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;
const SHA = /^[0-9a-f]{40}$/;

/**
 * The `app-shell.html` precache entry workbox writes into `sw.js`, whose
 * `revision` is `VITE_GIT_SHA` (see `frontend/vite.config.ts`). Both key orders
 * are accepted because the emitted order is workbox's to choose, not ours.
 */
const SHELL_REVISION = [
  /revision\s*:\s*["']([0-9a-f]{40})["']\s*,\s*url\s*:\s*["']app-shell\.html["']/,
  /url\s*:\s*["']app-shell\.html["']\s*,\s*revision\s*:\s*["']([0-9a-f]{40})["']/,
];

/**
 * Paths whose change alters what a visitor receives.
 *
 * Deliberately narrow. This repository merges many commits that reach no visitor —
 * tests, ADRs, the CI workflows, the audit docs — and counting them would make the
 * number meaningless long before it made it alarming. A prefix ending in `/` matches
 * a subtree; anything else must match the path exactly.
 *
 * `.github/workflows/cd-production.yml` is on the list because it is the publisher:
 * it is where `VITE_GIT_SHA` and the production build flags are set, so a change to
 * it can change the emitted bundle. The rest of `.github/` is not, for the same
 * reason the tests are not.
 *
 * `package-lock.json` is deliberately absent. A dependency bump does change the
 * bundle, and including the lock would also make every Renovate commit
 * visitor-visible and drown the signal; the workspace `package.json` files are on
 * the list so a declared dependency change still counts.
 *
 * `frontend/scripts/` is a subtree rather than a list of the build scripts in it,
 * deliberately. A hand-kept list drifts, and it drifts in the direction of missing a
 * change — PR #723 added `frontend/scripts/app-routes.mjs`, which a list written the
 * week before would not have named. `NOT_SHIPPED` removes the repo gates that live
 * in the same directory, so the error this can make is counting one commit too many.
 */
export const SITE_SOURCE = [
  'frontend/src/',
  'frontend/public/',
  'frontend/scripts/',
  'frontend/index.html',
  'frontend/package.json',
  'frontend/vite.config.ts',
  'frontend/vite.manualChunks.ts',
  'frontend/vite.navigationFallback.ts',
  'backend/src/',
  'backend/package.json',
  'infrastructure/',
  '.github/workflows/cd-production.yml',
];

/** Files inside those trees that ship to nobody. `frontend/src/sentry.test.ts` is real. */
const NOT_SHIPPED = [
  /(^|\/)__tests__\//,
  /(^|\/)tests?\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  // Repo gates and their baselines sit beside the build scripts in
  // `frontend/scripts/`. They inspect the bundle; they are not part of it.
  /^frontend\/scripts\/check-/,
  /^frontend\/scripts\/[^/]*-baseline\.json$/,
  // Mobile packaging and the brand-asset renderer: their outputs are committed
  // under `frontend/public/`, which is already on the list, so counting the
  // generators as well would double-count a brand change and count a store
  // release as a web change.
  /^frontend\/scripts\/(build-mobile-release\.sh|render-brand-assets\.sh|brand-assets\/)/,
];

/**
 * The comparison could not be made, so no number is reported.
 *
 * Raised in preference to returning zero anywhere the inputs do not support a
 * measurement. The caller turns this into a red run: a sentinel that cannot tell is
 * a broken sentinel and it has to look broken.
 */
export class StalenessUnknown extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'StalenessUnknown';
  }
}

/**
 * The commit whose frontend bytes CloudFront is serving right now.
 *
 * @param {string} serviceWorker the body of `https://familygreenhouse.net/sw.js`
 * @returns {string} 40-hex commit id
 */
export function liveFrontendCommit(serviceWorker) {
  for (const pattern of SHELL_REVISION) {
    const match = pattern.exec(serviceWorker);
    if (match) return match[1];
  }
  // Not "assume it is fine". If the fingerprint moves — workbox changes its
  // emitted shape, the precache entry is renamed, `VITE_GIT_SHA` stops being
  // passed — this sentinel is measuring nothing, and it has to say so.
  throw new StalenessUnknown(
    'the live service worker carries no app-shell.html revision: the frontend no longer ' +
      'reports which commit it was built from, so what a visitor receives cannot be identified ' +
      '(check VITE_GIT_SHA in frontend/vite.config.ts and cd-production.yml)'
  );
}

/**
 * The commit the live Lambda environment claims, from `GET /health`.
 *
 * This is corroboration, never the answer: a rollback restores Lambda code but not
 * the Terraform-set `GIT_SHA`, so this keeps reporting a release that is no longer
 * running. Its disagreement with the frontend is the useful part.
 *
 * @param {unknown} health the parsed `/health` body
 */
export function liveApiCommit(health) {
  const version = /** @type {{ version?: unknown }} */ (health)?.version;
  if (typeof version !== 'string' || !SHA.test(version)) {
    throw new StalenessUnknown(
      `the live /health endpoint reports version ${JSON.stringify(version)}, which is not a ` +
        'commit id: the deployed build cannot be identified from the API'
    );
  }
  return version;
}

/**
 * Did this deployment row actually publish bytes?
 *
 * `inactive` is the auto-inactivation GitHub applies to older deployments once a
 * newer one succeeds; measured here, 71 of this repository's 100 `production` rows
 * are in that state and every one of them has `success` behind it. Treating
 * `inactive` as "never published" would reject every row but the current release's
 * and leave the live build undatable.
 *
 * @param {Array<{ state: string }>} statuses newest first, as the API returns them
 */
export function published(statuses) {
  if (!statuses || statuses.length === 0) return false;
  if (statuses[0].state === 'failure' || statuses[0].state === 'error') return false;
  return statuses.some((status) => status.state === 'success');
}

/**
 * @typedef {object} Deployment
 * @property {number} id
 * @property {string} sha
 * @property {string} ref
 * @property {Date}   createdAt
 */

/**
 * Every `production` deployment that published, newest first.
 *
 * @param {Array<Record<string, unknown>>} deployments
 * @param {Record<string, Array<{ state: string }>>} statusesById
 * @returns {Deployment[]}
 */
export function publishedDeployments(deployments, statusesById) {
  const rows = (deployments ?? [])
    .filter((row) => SHA.test(String(row.sha)))
    .filter((row) => published(statusesById[String(row.id)]))
    .map((row) => ({
      id: Number(row.id),
      sha: String(row.sha),
      ref: String(row.ref ?? ''),
      createdAt: new Date(String(row.created_at)),
    }))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  if (rows.length === 0) {
    throw new StalenessUnknown(
      'no production deployment in this repository reports a successful publish: nothing here ' +
        'proves any build was ever shipped, so there is nothing to compare main against'
    );
  }
  return rows;
}

/** Does changing this file change what the published site shows? */
export function shipsToVisitors(path) {
  if (NOT_SHIPPED.some((pattern) => pattern.test(path))) return false;
  return SITE_SOURCE.some((prefix) =>
    prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix
  );
}

/**
 * The environment `git` is run in, with the repository overrides stripped out.
 *
 * `-C <dir>` does NOT win against an inherited `GIT_DIR`: git resolves the
 * environment first, so a caller that already has one — every git hook sets both
 * `GIT_DIR` and `GIT_INDEX_FILE`, and `.githooks/pre-push` runs `npm run verify`,
 * which runs this file's tests — silently redirects every command below to that
 * repository instead of `repoRoot`. It was caught here the hard way: the git-backed
 * tests passed standalone and failed only under the pre-push hook, and they were
 * "passing" against the wrong repository until they did. Stripping the overrides is
 * what makes `repoRoot` mean what it says.
 */
const GIT_OVERRIDES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_PREFIX',
];

/** Read at call time, not at import: the caller may set one after loading this. */
const gitEnv = () =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => !GIT_OVERRIDES.includes(name)));

/** @param {string[]} args @param {string} repoRoot */
function git(args, repoRoot) {
  try {
    return execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      env: gitEnv(),
    }).trim();
  } catch (error) {
    throw new StalenessUnknown(`git ${args.join(' ')} failed: ${String(error)}`);
  }
}

/**
 * Whether this clone contains the commit, without raising on absence.
 *
 * `git cat-file` exits non-zero for a commit that is simply not here, which is the
 * ordinary shallow-clone case and not a git failure. Routing it through `git()`
 * would report it as one and the refusal that names the shallow checkout would never
 * be reached.
 */
function hasCommit(sha, repoRoot) {
  try {
    execFileSync('git', ['-C', repoRoot, 'cat-file', '-e', `${sha}^{commit}`], {
      stdio: 'ignore',
      env: gitEnv(),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Refuse unless this clone can actually place the live commit on `main`.
 *
 * Both failures below report zero drift if they are not caught, and both are
 * ordinary. A shallow checkout does not contain a commit from three weeks ago, so
 * `git log <live>..origin/main` lists nothing and the site reads as up to date —
 * which is why the sentinel workflow checks out with `fetch-depth: 0` and why this
 * refuses rather than trusting that it did. A force-push or a rebase leaves the live
 * commit off `main` entirely, where "commits since" is not a question with an answer.
 */
export function requireComparable(liveSha, headSha, repoRoot = ROOT) {
  if (!SHA.test(liveSha)) {
    throw new StalenessUnknown(`live commit ${JSON.stringify(liveSha)} is not a commit id`);
  }
  if (!hasCommit(liveSha, repoRoot)) {
    throw new StalenessUnknown(
      `live commit ${liveSha.slice(0, 9)} is not in this clone: the checkout is shallow, and a ` +
        'comparison against a history that does not reach the live build would report no drift ' +
        'at all'
    );
  }
  if (git(['merge-base', liveSha, headSha], repoRoot) !== git(['rev-parse', liveSha], repoRoot)) {
    throw new StalenessUnknown(
      `live commit ${liveSha.slice(0, 9)} is not an ancestor of ${headSha.slice(0, 9)}: the ` +
        "history has diverged and 'commits since the deploy' has no answer"
    );
  }
}

/**
 * Each commit after the live one, with its commit date and the paths it touched.
 *
 * Merges carry no `--name-only` output, which is correct here: this repository
 * squash-merges, so every commit on `main` is an ordinary one.
 */
export function commitsSince(liveSha, headSha, repoRoot = ROOT) {
  const raw = git(
    ['log', '--format=%x00%H %ct', '--name-only', `${liveSha}..${headSha}`],
    repoRoot
  );
  return raw
    .split('\0')
    .map((block) => block.split('\n').filter((line) => line.trim() !== ''))
    .filter((lines) => lines.length > 0)
    .map(([header, ...paths]) => {
      const [sha, seconds] = header.split(' ');
      return { sha, committedAt: new Date(Number(seconds) * 1000), paths };
    });
}

/**
 * The whole verdict, as data. Pure: no clock of its own, no network, no filesystem.
 *
 * @param {object} input
 * @param {string} input.frontendSha  commit the live frontend bytes came from
 * @param {string} input.apiSha       commit `/health` reports
 * @param {Deployment[]} input.deployments published rows, newest first
 * @param {string} input.headSha
 * @param {Array<{ sha: string, committedAt: Date, paths: string[] }>} input.commits
 * @param {Date} input.now
 * @param {number} input.maxAgeDays
 */
export function evaluate({ frontendSha, apiSha, deployments, headSha, commits, now, maxAgeDays }) {
  // Which deploy put the bytes a visitor is receiving in place. Without it the live
  // build cannot be dated, and bytes from a commit no deployment names mean
  // something published outside this pipeline — either way, refuse.
  const liveDeployment = deployments.find((row) => row.sha === frontendSha);
  if (!liveDeployment) {
    throw new StalenessUnknown(
      `the live frontend was built from ${frontendSha.slice(0, 9)}, which no successful ` +
        'production deployment names: the bytes being served did not come from this pipeline, ' +
        'or the deployment that published them has aged out of the API window'
    );
  }

  const newestPublished = deployments[0];
  const visitorCommits = commits.filter((commit) => commit.paths.some(shipsToVisitors));
  const oldestWaiting = visitorCommits.at(-1) ?? null;

  const result = {
    frontendSha,
    apiSha,
    headSha,
    deploymentId: liveDeployment.id,
    deployedRef: liveDeployment.ref,
    deployedAt: liveDeployment.createdAt,
    buildAgeDays: Math.floor((now.getTime() - liveDeployment.createdAt.getTime()) / DAY_MS),
    commits: commits.length,
    visitorCommits: visitorCommits.length,
    // How long the oldest unreleased visitor-visible change has waited, measured
    // from when it landed rather than from the last deploy. See the header.
    waitingDays: oldestWaiting
      ? Math.floor((now.getTime() - oldestWaiting.committedAt.getTime()) / DAY_MS)
      : 0,
    maxAgeDays,
    // The deployment record's newest successful publish is not what visitors get.
    // The auto-rollback's signature, and also what a half-applied release looks
    // like: on 2026-07-19 `Deploy Frontend` failed at v0.22.0 while `Deploy Backend`
    // succeeded, and the rollback failed too.
    recordDisagrees: newestPublished.sha !== frontendSha,
    recordSha: newestPublished.sha,
    recordRef: newestPublished.ref,
    // `/health` and the frontend disagreeing means half the stack is on one commit
    // and half on another. After an auto-rollback this is the expected state, because
    // GIT_SHA is a Terraform-set Lambda variable the rollback does not revert.
    apiDisagrees: apiSha !== frontendSha,
  };

  return {
    ...result,
    overdue:
      result.recordDisagrees ||
      result.apiDisagrees ||
      (result.visitorCommits > 0 && result.waitingDays > maxAgeDays),
  };
}

/** Read the record, place the live commit against `main`, or refuse. */
export function measure({
  deployments,
  statusesById,
  serviceWorker,
  health,
  head = 'origin/main',
  now = new Date(),
  maxAgeDays = DEFAULT_MAX_AGE_DAYS,
  repoRoot = ROOT,
}) {
  const frontendSha = liveFrontendCommit(serviceWorker);
  const apiSha = liveApiCommit(health);
  const rows = publishedDeployments(deployments, statusesById);
  const headSha = git(['rev-parse', head], repoRoot);
  requireComparable(frontendSha, headSha, repoRoot);

  return evaluate({
    frontendSha,
    apiSha,
    deployments: rows,
    headSha,
    commits: commitsSince(frontendSha, headSha, repoRoot),
    now,
    maxAgeDays,
  });
}

/** The report. States the measurement before its verdict, always. */
export function report(result) {
  const deployedOn = result.deployedAt.toISOString().slice(0, 10);
  const deployedAs = result.deployedRef || 'an untagged ref';
  const lines = [
    `Live frontend:     ${result.frontendSha.slice(0, 9)}  (deployed ${deployedOn} as ` +
      `${deployedAs}, deployment ${result.deploymentId})`,
    `Live API:          ${result.apiSha.slice(0, 9)}  (GET /health)`,
    `Deployment record: ${result.recordSha.slice(0, 9)}  (${result.recordRef || 'untagged'})`,
    `main:              ${result.headSha.slice(0, 9)}`,
    `Behind by:         ${result.commits} commits, ${result.visitorCommits} of them changing ` +
      `what a visitor receives; the build is ${result.buildAgeDays} days old`,
  ];

  if (result.visitorCommits > 0) {
    lines.push(
      `Oldest unreleased visitor-visible change has waited ${result.waitingDays} days ` +
        `(threshold ${result.maxAgeDays}).`
    );
  }

  if (result.recordDisagrees) {
    lines.push(
      '',
      `ROLLED BACK OR HALF-APPLIED: the newest successful production deployment names ` +
        `${result.recordSha.slice(0, 9)}, but visitors are being served ` +
        `${result.frontendSha.slice(0, 9)}. cd-production.yml's rollback job restores the ` +
        'previous frontend snapshot without touching the deployment record, so this is what ' +
        'an auto-rollback looks like from outside. The release the record claims is not live.'
    );
  }

  if (result.apiDisagrees) {
    lines.push(
      '',
      `SPLIT STACK: /health reports ${result.apiSha.slice(0, 9)} while the frontend serves ` +
        `${result.frontendSha.slice(0, 9)}. GIT_SHA is a Terraform-set Lambda variable that the ` +
        'rollback does not revert, so after an auto-rollback the API keeps naming the release ' +
        'it rolled away from. Confirm which Lambda code is actually running before redeploying.'
    );
  }

  if (result.visitorCommits > 0 && result.waitingDays > result.maxAgeDays) {
    lines.push(
      '',
      `OVERDUE: ${result.visitorCommits} visitor-visible commit(s) have waited ` +
        `${result.waitingDays} days without a release, past the ${result.maxAgeDays}-day ` +
        'threshold. Deploys here are tag-gated; nothing merged since reaches a visitor until ' +
        'a v* tag is pushed.'
    );
  }

  if (!result.overdue) {
    lines.push(
      '',
      result.visitorCommits > 0
        ? `Waiting: ${result.visitorCommits} visitor-visible commit(s), within the ` +
            `${result.maxAgeDays}-day threshold.`
        : 'Up to date: nothing a visitor receives has changed since the live build.'
    );
  }

  return lines.join('\n');
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  const args = {
    head: 'origin/main',
    maxAgeDays: DEFAULT_MAX_AGE_DAYS,
    json: false,
    expectFailure: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--json') args.json = true;
    else if (flag === '--expect-failure') args.expectFailure = true;
    else if (flag === '--deployments') args.deployments = argv[++i];
    else if (flag === '--statuses') args.statuses = argv[++i];
    else if (flag === '--service-worker') args.serviceWorker = argv[++i];
    else if (flag === '--health') args.health = argv[++i];
    else if (flag === '--head') args.head = argv[++i];
    else if (flag === '--max-age-days') args.maxAgeDays = Number(argv[++i]);
    else throw new Error(`unknown argument: ${flag}`);
  }
  for (const required of ['deployments', 'statuses', 'serviceWorker', 'health']) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  return args;
}

/**
 * Exit 2 on a refusal, not 0 with a reassuring report. The sentinel workflow turns a
 * measurement into an issue and a refusal into a red run, so this exit code is the
 * whole difference between "the site is fine" and "nobody can tell".
 */
export function main(argv) {
  const args = parseArgs(argv);
  let result;
  try {
    result = measure({
      deployments: JSON.parse(readFileSync(args.deployments, 'utf8')),
      statusesById: JSON.parse(readFileSync(args.statuses, 'utf8')),
      serviceWorker: readFileSync(args.serviceWorker, 'utf8'),
      health: JSON.parse(readFileSync(args.health, 'utf8')),
      head: args.head,
      maxAgeDays: args.maxAgeDays,
    });
  } catch (error) {
    if (!(error instanceof StalenessUnknown)) throw error;
    process.stderr.write(`cannot measure deploy staleness: ${error.message}\n`);
    writeGithubOutput({ measured: false, error: error.message });
    // The negative control, run the same way uptime.yml runs its own: prove the
    // check can still refuse before believing that it measured.
    if (args.expectFailure) {
      process.stdout.write('Negative control: the sentinel refused as required.\n');
      return 0;
    }
    return 2;
  }

  process.stdout.write(`${args.json ? JSON.stringify(result, null, 2) : report(result)}\n`);
  writeGithubOutput({ measured: true, overdue: result.overdue });
  if (args.expectFailure) {
    process.stderr.write('Expected a refusal and the sentinel produced a measurement.\n');
    return 1;
  }
  return 0;
}

function writeGithubOutput({ measured, overdue, error }) {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) return;
  appendFileSync(
    path,
    measured
      ? `measured=true\noverdue=${String(overdue)}\n`
      : `measured=false\nerror=${String(error).replace(/\n/g, ' ')}\n`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
