#!/usr/bin/env node
/**
 * Prunes superseded, content-hashed frontend assets from the production bucket
 * after a release has passed its post-deploy smoke.
 *
 * ## Why this is a script and its own job
 *
 * It used to be the last-but-one step of `deploy-frontend`, guarded by "refuse
 * if the prune wants more than half of the bucket". v0.38.1 (2026-10-02) showed
 * both halves were wrong:
 *
 * - The ratio was the wrong guard. The bucket holds the live build plus every
 *   build still inside the grace period, so after a quiet spell it is mostly
 *   superseded by construction. On v0.38.1 the diff was exactly right — 1,202
 *   `assets/` files from the seven builds v0.31.0 to v0.37.0, all at least
 *   thirteen days old, none in the new build — and it was refused as "wrong".
 *   v0.31.0 had already deleted 416 of 867 (48%), one file under the line.
 * - The refusal failed `deploy-frontend`, which skipped the smoke, which fired
 *   `rollback`, which reverted a release that was fine. It also skipped the
 *   CloudFront invalidation that came after it. Housekeeping must never decide
 *   whether production is reverted, so the prune now runs in its own job, only
 *   after the smoke passed, and nothing that can roll back reads it.
 *
 * ## What it deletes
 *
 * A bucket key is deleted only when ALL of these hold:
 *   1. it is a content-hashed asset: `assets/<name>-<8-char hash>.<ext>`. HTML,
 *      `sw.js`, `robots.txt` and the rest are never touched here (the HTML sync
 *      already uses `--delete`);
 *   2. it is absent from the build just deployed;
 *   3. it was last modified more than GRACE_DAYS ago, so a tab left open across
 *      a release keeps working until it is refreshed.
 *
 * `aws s3 sync` skips unchanged files, so a stable chunk keeps an old
 * LastModified while still being live. Condition 2 is what protects it; a pure
 * age rule (an S3 lifecycle rule) would delete exactly those files.
 *
 * ## What it refuses, deleting nothing
 *
 * The guard asks "is this the bucket this build was deployed to?", not "is the
 * prune big?":
 *   - the listing is empty;
 *   - the build has no `index.html` or no hashed assets (an empty or wrong
 *     `dist/`);
 *   - any hashed asset of the build is missing from the bucket listing (a
 *     wrong bucket, a wrong prefix, a truncated listing, or a build that was
 *     never uploaded). If even one live file is unaccounted for, the diff
 *     cannot be trusted;
 *   - the prune would remove more than MAX_BUILDS builds' worth of assets
 *     (MAX_BUILDS x the build's own hashed-asset count). A sanity bound, far
 *     above the v0.38.1 backlog (1,202 against 20 x 318), that still stops a
 *     bucket that is not shaped like a release history.
 *
 * Dry run is the default. `--apply` deletes, with `delete-objects` in batches
 * of 1,000 and every per-key error reported.
 *
 * Usage (read-only, what the owner runs first):
 *   aws s3api list-objects-v2 --bucket "$B" \
 *     --query 'Contents[].[Key,LastModified]' --output text > objects.tsv
 *   node scripts/prune-frontend-assets.mjs --dist <dir> --listing objects.tsv
 *
 * Or let it list: `--bucket "$B"` instead of `--listing`. Add `--apply` to delete.
 * `--now <ISO>` pins the clock (tests and a reproducible dry run).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_GRACE_DAYS = 7;
export const DEFAULT_MAX_BUILDS = 20;
export const DELETE_BATCH = 1000;

/** `assets/<name>-<8-char content hash>.<ext>`, one directory level, as Vite emits them. */
export const HASHED_ASSET = /^assets\/[^/]+-[A-Za-z0-9_-]{8}\.[A-Za-z0-9.]+$/;

/**
 * Parses `list-objects-v2 --query 'Contents[].[Key,LastModified]' --output text`.
 * The CLI prints `None` for an empty bucket; that is zero objects, not a key.
 */
export function parseListing(text) {
  const objects = [];
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trim() === 'None') continue;
    const [key, lastModified] = line.split('\t');
    if (!key || !lastModified) throw new Error(`unreadable listing line: ${JSON.stringify(line)}`);
    const when = new Date(lastModified.trim());
    if (Number.isNaN(when.getTime()))
      throw new Error(`unreadable LastModified for ${key}: ${lastModified}`);
    objects.push({ key, lastModified: when });
  }
  return objects;
}

/** Every file under `dir`, as bucket keys (forward slashes, no leading `./`). */
export function listBuild(dir) {
  const keys = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else keys.push(relative(dir, p).split(sep).join('/'));
    }
  };
  walk(dir);
  return keys.sort();
}

/**
 * The decision, with no I/O. Returns `{ ok, refusals, prune, summary }`; when
 * `ok` is false, `prune` is always empty.
 */
export function planPrune({
  shipped,
  objects,
  now,
  graceDays = DEFAULT_GRACE_DAYS,
  maxBuilds = DEFAULT_MAX_BUILDS,
}) {
  const shippedSet = new Set(shipped);
  const shippedAssets = shipped.filter((k) => HASHED_ASSET.test(k));
  const listed = new Set(objects.map((o) => o.key));
  const cutoff = new Date(now.getTime() - graceDays * 24 * 60 * 60 * 1000);
  const refusals = [];

  if (objects.length === 0) {
    refusals.push('the bucket listing is empty, moments after a deploy wrote to it');
  }
  if (!shippedSet.has('index.html')) {
    refusals.push('the build has no index.html, so it is not a frontend build');
  }
  if (shippedAssets.length === 0) {
    refusals.push(
      'the build has no hashed assets/ files, so there is nothing to compare the bucket against'
    );
  }
  const missing = objects.length === 0 ? [] : shippedAssets.filter((k) => !listed.has(k));
  if (missing.length > 0) {
    refusals.push(
      `${missing.length} of the build's ${shippedAssets.length} hashed assets are not in the bucket ` +
        `(first: ${missing[0]}); this is not the bucket this build was deployed to, or the listing is incomplete`
    );
  }

  const candidates = objects
    .filter((o) => HASHED_ASSET.test(o.key) && !shippedSet.has(o.key) && o.lastModified < cutoff)
    .map((o) => o.key)
    .sort();

  const bound = maxBuilds * shippedAssets.length;
  if (shippedAssets.length > 0 && candidates.length > bound) {
    refusals.push(
      `the prune would remove ${candidates.length} assets, more than ${maxBuilds} builds' worth ` +
        `(${maxBuilds} x ${shippedAssets.length} = ${bound}); the bucket is not shaped like a release history`
    );
  }

  const ok = refusals.length === 0;
  return {
    ok,
    refusals,
    prune: ok ? candidates : [],
    candidates: candidates.length,
    cutoff,
    total: objects.length,
    shippedAssets: shippedAssets.length,
  };
}

export function describe(plan) {
  const lines = [
    `bucket objects: ${plan.total}; build hashed assets: ${plan.shippedAssets}; grace cutoff: ${plan.cutoff.toISOString()}`,
  ];
  if (!plan.ok) {
    lines.push(`REFUSED: deleting nothing. ${plan.candidates} superseded assets were candidates.`);
    for (const r of plan.refusals) lines.push(`  - ${r}`);
  } else if (plan.prune.length === 0) {
    lines.push('nothing to prune');
  } else {
    lines.push(`${plan.prune.length} superseded assets to delete (of ${plan.total} objects):`);
    for (const k of plan.prune) lines.push(`  ${k}`);
  }
  return lines.join('\n');
}

function defaultAws(args) {
  const r = spawnSync('aws', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0)
    throw new Error(`aws ${args.slice(0, 2).join(' ')} failed: ${r.stderr || r.error}`);
  return r.stdout;
}

/** Deletes `keys` in batches; throws when any key reports an error. */
export function deleteKeys({ bucket, keys, aws = defaultAws }) {
  const dir = mkdtempSync(join(tmpdir(), 'fg-prune-'));
  let deleted = 0;
  const errors = [];
  try {
    for (let i = 0; i < keys.length; i += DELETE_BATCH) {
      const batch = keys.slice(i, i + DELETE_BATCH);
      const file = join(dir, `batch-${i}.json`);
      writeFileSync(file, JSON.stringify({ Objects: batch.map((Key) => ({ Key })), Quiet: true }));
      const out = aws([
        's3api',
        'delete-objects',
        '--bucket',
        bucket,
        '--delete',
        `file://${file}`,
        '--output',
        'json',
      ]);
      const parsed = out.trim() ? JSON.parse(out) : {};
      for (const e of parsed.Errors ?? []) errors.push(`${e.Key}: ${e.Code} ${e.Message}`);
      deleted += batch.length - (parsed.Errors ?? []).length;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (errors.length > 0)
    throw new Error(`${errors.length} deletes failed:\n  ${errors.join('\n  ')}`);
  return deleted;
}

function parseArgs(argv) {
  const opts = { apply: false, graceDays: DEFAULT_GRACE_DAYS, maxBuilds: DEFAULT_MAX_BUILDS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--dist') opts.dist = next();
    else if (a === '--listing') opts.listing = next();
    else if (a === '--bucket') opts.bucket = next();
    else if (a === '--grace-days') opts.graceDays = Number(next());
    else if (a === '--max-builds') opts.maxBuilds = Number(next());
    else if (a === '--now') opts.now = new Date(next());
    else if (a === '--apply') opts.apply = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!opts.dist) throw new Error('--dist <build dir> is required');
  if (!opts.listing && !opts.bucket)
    throw new Error('--listing <file> or --bucket <name> is required');
  if (opts.apply && !opts.bucket) throw new Error('--apply needs --bucket');
  if (!(opts.graceDays >= 1)) throw new Error('--grace-days must be at least 1');
  if (!(opts.maxBuilds >= 1)) throw new Error('--max-builds must be at least 1');
  return opts;
}

export function main(argv, { aws = defaultAws, log = console.log, error = console.error } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    error(e.message);
    return 2;
  }
  const listingText = opts.listing
    ? readFileSync(opts.listing, 'utf8')
    : aws([
        's3api',
        'list-objects-v2',
        '--bucket',
        opts.bucket,
        '--query',
        'Contents[].[Key,LastModified]',
        '--output',
        'text',
      ]);
  const plan = planPrune({
    shipped: listBuild(opts.dist),
    objects: parseListing(listingText),
    now: opts.now ?? new Date(),
    graceDays: opts.graceDays,
    maxBuilds: opts.maxBuilds,
  });
  log(describe(plan));
  if (!plan.ok) {
    error(
      '::error::asset prune refused; nothing was deleted. The release itself is live and unaffected. See docs/deployment.md, "Asset prune refused".'
    );
    return 1;
  }
  if (!opts.apply) {
    if (plan.prune.length > 0)
      log('DRY RUN: nothing was deleted. Re-run with --apply --bucket <name> to delete.');
    return 0;
  }
  if (plan.prune.length === 0) return 0;
  const deleted = deleteKeys({ bucket: opts.bucket, keys: plan.prune, aws });
  log(`deleted ${deleted} superseded assets`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
