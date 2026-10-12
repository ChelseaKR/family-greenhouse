import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { load } from 'js-yaml';

import {
  DELETE_BATCH,
  deleteKeys,
  main,
  parseListing,
  planPrune,
} from './prune-frontend-assets.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = new Date('2026-10-02T17:55:51Z');
const OLD = new Date('2026-09-19T02:50:00Z');
const FRESH = new Date('2026-10-02T17:55:00Z');

const hash = (i) => `h${String(i).padStart(7, '0')}`;
/** A build: index.html, a few pages, and `n` hashed assets named for `tag`. */
function build(tag, n, shared = []) {
  return [
    'index.html',
    'app-shell.html',
    'sw.js',
    'robots.txt',
    ...shared,
    ...Array.from({ length: n }, (_, i) => `assets/${tag}Chunk${i}-${hash(i)}.js`),
  ].sort();
}
const objectsOf = (keys, when) => keys.map((key) => ({ key, lastModified: when }));

// The shape v0.38.1 met: seven superseded builds of ~170 unique assets each, all
// thirteen days old, a few shared with the new build, and the new build's own
// files just uploaded. 1,202 of 1,617 objects were superseded, and correctly so.
function v0381Bucket() {
  const shared = Array.from({ length: 20 }, (_, i) => `assets/vendor${i}-${hash(i)}.js`);
  const shipped = build('v0381', 298, shared);
  const old = [];
  for (let r = 31; r <= 37; r++)
    old.push(...build(`v0${r}0`, 172).filter((k) => k.startsWith('assets/')));
  const bucket = [
    ...objectsOf(old, OLD),
    ...objectsOf(shared, OLD), // unchanged since an older release: stable, live, old LastModified
    ...objectsOf(
      shipped.filter((k) => !shared.includes(k)),
      FRESH
    ),
  ];
  return { shipped, bucket, old, shared };
}

test('the v0.38.1 backlog is pruned, not refused: a large prune is not a wrong diff', () => {
  const { shipped, bucket, old } = v0381Bucket();
  const plan = planPrune({ shipped, objects: bucket, now: NOW });
  assert.equal(plan.ok, true, plan.refusals.join('; '));
  assert.ok(
    plan.prune.length > bucket.length / 2,
    'the fixture must exceed the old half-of-bucket line'
  );
  assert.deepEqual(plan.prune, [...old].sort());
});

test('a live asset with an old LastModified is never pruned', () => {
  const { shipped, bucket, shared } = v0381Bucket();
  const plan = planPrune({ shipped, objects: bucket, now: NOW });
  for (const k of shared) assert.ok(!plan.prune.includes(k), k);
});

test('an asset inside the grace period is kept, and the boundary is exclusive', () => {
  const shipped = build('new', 3);
  const gone = 'assets/Gone-abcdefgh.js';
  const at = (d) => [...objectsOf(shipped, FRESH), { key: gone, lastModified: d }];
  const sevenDays = new Date(NOW.getTime() - 7 * 86400000);
  assert.deepEqual(planPrune({ shipped, objects: at(sevenDays), now: NOW }).prune, []);
  assert.deepEqual(
    planPrune({ shipped, objects: at(new Date(sevenDays.getTime() - 1000)), now: NOW }).prune,
    [gone]
  );
});

test('only hashed assets are candidates: HTML, sw.js and unhashed files are never pruned', () => {
  const shipped = build('new', 3);
  const objects = [
    ...objectsOf(shipped, FRESH),
    ...objectsOf(
      [
        'old-route/index.html',
        'sw-old.js',
        'assets/logo.svg',
        'assets/nested/x-abcdefgh.js',
        'brand/a-abcdefgh.png',
      ],
      OLD
    ),
  ];
  const plan = planPrune({ shipped, objects, now: NOW });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.prune, []);
});

// --- the guard: a diff that cannot be trusted deletes nothing -----------------

test('negative control: an empty build is refused and deletes nothing', () => {
  const { bucket } = v0381Bucket();
  const plan = planPrune({ shipped: [], objects: bucket, now: NOW });
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.prune, []);
  assert.ok(plan.candidates > 0, 'the control must have had something to delete');
  assert.match(plan.refusals.join('\n'), /no index\.html/);
  assert.match(plan.refusals.join('\n'), /no hashed assets/);
});

test('negative control: a build that is not in the bucket (wrong bucket, prefix or listing) is refused', () => {
  const { bucket } = v0381Bucket();
  // A real build, but not the one this bucket received.
  const plan = planPrune({ shipped: build('other', 300), objects: bucket, now: NOW });
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.prune, []);
  assert.ok(plan.candidates > 0);
  assert.match(
    plan.refusals.join('\n'),
    /300 of the build's 300 hashed assets are not in the bucket/
  );
});

test('negative control: one missing live asset is enough to refuse', () => {
  const { shipped, bucket } = v0381Bucket();
  const dropped = shipped.find((k) => k.startsWith('assets/v0381'));
  const plan = planPrune({ shipped, objects: bucket.filter((o) => o.key !== dropped), now: NOW });
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.prune, []);
  assert.match(
    plan.refusals.join('\n'),
    new RegExp(`1 of the build's \\d+ hashed assets.*${dropped}`)
  );
});

test('negative control: an empty listing is refused', () => {
  const plan = planPrune({ shipped: build('new', 3), objects: [], now: NOW });
  assert.equal(plan.ok, false);
  assert.match(plan.refusals.join('\n'), /listing is empty/);
});

test('the sanity bound refuses a bucket far larger than any release history', () => {
  const shipped = build('new', 10);
  const junk = Array.from({ length: 201 }, (_, i) => `assets/Junk${i}-${hash(i)}.js`);
  const objects = [...objectsOf(shipped, FRESH), ...objectsOf(junk, OLD)];
  const refused = planPrune({ shipped, objects, now: NOW, maxBuilds: 20 });
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.prune, []);
  assert.match(refused.refusals.join('\n'), /more than 20 builds' worth \(20 x 10 = 200\)/);
  assert.equal(
    planPrune({ shipped, objects: objects.slice(0, -1), now: NOW, maxBuilds: 20 }).ok,
    true
  );
});

test('parseListing reads the CLI text output, including the empty-bucket `None`', () => {
  const objs = parseListing(
    'assets/a-abcdefgh.js\t2026-09-19T02:50:00+00:00\nindex.html\t2026-10-02T17:55:00.000Z\n'
  );
  assert.equal(objs.length, 2);
  assert.equal(objs[0].lastModified.toISOString(), '2026-09-19T02:50:00.000Z');
  assert.deepEqual(parseListing('None\n'), []);
  assert.throws(
    () => parseListing('assets/a-abcdefgh.js\tnot-a-date\n'),
    /unreadable LastModified/
  );
});

// --- deletion and the CLI ----------------------------------------------------

test('deleteKeys batches by 1,000 and fails on any per-key error', () => {
  const calls = [];
  const aws = (args) => {
    const file = args[args.indexOf('--delete') + 1].replace('file://', '');
    calls.push(JSON.parse(readFileSync(file, 'utf8')).Objects.length);
    return '{}';
  };
  const keys = Array.from({ length: DELETE_BATCH + 202 }, (_, i) => `assets/K${i}-${hash(i)}.js`);
  assert.equal(deleteKeys({ bucket: 'b', keys, aws }), keys.length);
  assert.deepEqual(calls, [DELETE_BATCH, 202]);

  const failing = () =>
    JSON.stringify({
      Errors: [{ Key: 'assets/K1-h0000001.js', Code: 'AccessDenied', Message: 'no' }],
    });
  assert.throws(
    () => deleteKeys({ bucket: 'b', keys: keys.slice(0, 3), aws: failing }),
    /1 deletes failed:[\s\S]*AccessDenied/
  );
});

function writeDist(keys) {
  const dir = mkdtempSync(join(tmpdir(), 'fg-prune-dist-'));
  for (const k of keys) {
    mkdirSync(dirname(join(dir, k)), { recursive: true });
    writeFileSync(join(dir, k), 'x');
  }
  return dir;
}

test('the CLI is a dry run by default and deletes only with --apply', () => {
  const { shipped, bucket, old } = v0381Bucket();
  const dist = writeDist(shipped);
  const listing = bucket.map((o) => `${o.key}\t${o.lastModified.toISOString()}`).join('\n');
  const deleted = [];
  const aws = (args) => {
    if (args[1] === 'list-objects-v2') return listing;
    const file = args[args.indexOf('--delete') + 1].replace('file://', '');
    deleted.push(...JSON.parse(readFileSync(file, 'utf8')).Objects.map((o) => o.Key));
    return '{}';
  };
  const out = [];
  const io = { aws, log: (s) => out.push(s), error: (s) => out.push(s) };
  assert.equal(main(['--dist', dist, '--bucket', 'b', '--now', NOW.toISOString()], io), 0);
  assert.deepEqual(deleted, []);
  assert.match(out.join('\n'), /DRY RUN/);

  assert.equal(
    main(['--dist', dist, '--bucket', 'b', '--now', NOW.toISOString(), '--apply'], io),
    0
  );
  assert.deepEqual(deleted.sort(), [...old].sort());
});

test('the CLI exits 1 on a refusal and deletes nothing, even with --apply', () => {
  const { bucket } = v0381Bucket();
  const dist = writeDist(build('other', 5));
  const listing = bucket.map((o) => `${o.key}\t${o.lastModified.toISOString()}`).join('\n');
  let deletes = 0;
  const aws = (args) => {
    if (args[1] === 'list-objects-v2') return listing;
    deletes++;
    return '{}';
  };
  const out = [];
  const code = main(['--dist', dist, '--bucket', 'b', '--now', NOW.toISOString(), '--apply'], {
    aws,
    log: (s) => out.push(s),
    error: (s) => out.push(s),
  });
  assert.equal(code, 1);
  assert.equal(deletes, 0);
  assert.match(out.join('\n'), /REFUSED: deleting nothing/);
  assert.match(out.join('\n'), /The release itself is live and unaffected/);
});

// --- the workflow: a refused prune can never roll production back -------------

function cdProduction() {
  return load(readFileSync(join(ROOT, '.github/workflows/cd-production.yml'), 'utf8'));
}
const needsOf = (job) => [job.needs ?? []].flat();

test('deploy-frontend no longer prunes: nothing between the upload and the invalidation can refuse', () => {
  const { jobs } = cdProduction();
  const steps = jobs['deploy-frontend'].steps;
  for (const step of steps) assert.doesNotMatch(step.name ?? '', /prune/i);
  const run = steps.map((s) => s.run ?? '').join('\n');
  assert.doesNotMatch(
    run,
    /prune-frontend-assets\.mjs|aws s3 rm "s3:\/\/\$\{FRONTEND_BUCKET\}|delete-objects/
  );
  // The invalidation is the last step again, so nothing can skip it.
  assert.equal(steps.at(-1).name, 'Invalidate CloudFront');
});

test('the prune runs only after a passing smoke, and nothing that can roll back reads it', () => {
  const { jobs } = cdProduction();
  const job = jobs['prune-frontend-assets'];
  assert.ok(job, 'cd-production.yml has no prune-frontend-assets job');
  assert.ok(needsOf(job).includes('smoke-tests'));
  assert.match(job.if, /needs\.smoke-tests\.result == 'success'/);
  assert.doesNotMatch(job.if, /always\(\)|failure\(\)|cancelled\(\)/);
  // A refusal must be visible as a red job, not swallowed.
  assert.notEqual(job['continue-on-error'], true);
  const run = job.steps.map((s) => s.run ?? '').join('\n');
  assert.match(run, /node scripts\/prune-frontend-assets\.mjs[\s\S]*--apply/);

  assert.ok(!needsOf(jobs.rollback).includes('prune-frontend-assets'), 'rollback needs the prune');
  assert.doesNotMatch(String(jobs.rollback.if), /prune/);
  assert.doesNotMatch(String(jobs['smoke-tests'].if ?? ''), /prune/);
  // notify reports it, so a refusal is loud.
  assert.ok(needsOf(jobs.notify).includes('prune-frontend-assets'));
  assert.match(JSON.stringify(jobs.notify.steps), /PRUNE_RESULT/);
});

test('the prune job pins its actions and does not use an environment approval', () => {
  const job = cdProduction().jobs['prune-frontend-assets'];
  assert.equal(job.environment, undefined);
  for (const step of job.steps.filter((s) => s.uses))
    assert.match(step.uses, /@[0-9a-f]{40}$/, step.uses);
});
