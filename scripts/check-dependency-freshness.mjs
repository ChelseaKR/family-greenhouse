#!/usr/bin/env node
/**
 * Answers one question the rest of the gate cannot: is `node_modules` the tree
 * `package-lock.json` describes, or is it an older one? (#581)
 *
 * ## Why
 *
 * On 2026-09-05 a signed release tag was refused by the pre-push gate with:
 *
 *     gate FAILED — 1 of 28 steps failed in 83.3s: test:backend
 *
 * Nothing was wrong with the backend. The working tree had been fast-forwarded
 * 139 commits without a reinstall, one of those commits had added
 * `express-rate-limit` to `backend/package.json`, and fifteen suites were
 * failing with `Cannot find package 'express-rate-limit'`. CI was green
 * throughout, because CI installs from the lockfile on every run.
 *
 * The gate was not wrong — `test:backend` really did exit non-zero. It was
 * *unreadable*: it pointed at the backend suite, so that is where the next
 * eighty minutes went. "Your dependencies are stale" and "your code is broken"
 * produce the same red line, and only one of them is fixed by reading test
 * output. The pre-push hook already refuses a tree with no `node_modules` at
 * all (#544); this is the same guard for the much commoner case of a
 * `node_modules` that is merely *out of date*.
 *
 * ## What it compares
 *
 * `package-lock.json` is a complete description of the installed tree: every
 * package, at an exact version, at an exact path. So for each package the
 * lockfile says must be present, this reads `<path>/package.json` from disk and
 * compares the version. Root and both workspaces are covered in one pass —
 * the lockfile is a single tree spanning all three.
 *
 * Two outcomes, deliberately reported apart, because they read differently:
 *
 *   MISSING       nothing at that path. Usually a dependency that landed in
 *                 commits you have pulled and never installed.
 *   WRONG VERSION something is there, at a version the lockfile does not pin.
 *                 Usually a lockfile that moved under a tree installed from an
 *                 older one, or a hand-run `npm install <pkg>`.
 *
 * Both are fixed by `npm ci`, but a reader chasing the second one wants to know
 * which version they actually have, so it is printed.
 *
 * ## Not every absent package is a stale install
 *
 * This is the part that decides whether the check survives contact with real
 * trees. A check that cries wolf on a correctly-installed tree gets routed
 * around within a week, and then it is worse than nothing. Measured against
 * this repo's own lockfile, a naive "every lockfile entry must exist on disk"
 * rule reports 100 false alarms on a tree `npm ci` has just finished writing:
 *
 *   94  platform-specific optional packages — `@esbuild/aix-ppc64` and
 *       friends. npm installs only the entries whose `os`/`cpu` match the
 *       current machine and skips the rest, by design.
 *    5  transitively optional packages (`@emnapi/*`, `@napi-rs/wasm-runtime`,
 *       `@tybys/wasm-util`) reachable only through those skipped ones.
 *    1  `node_modules/husky` — a genuinely orphaned lockfile entry. Root
 *       `package.json` dropped husky when the hooks moved to `.githooks/`
 *       (#544) and the lockfile entry was never pruned. No manifest depends on
 *       it, so `npm ci` correctly does not install it.
 *
 * So "the lockfile lists it" is not the requirement. The requirement is
 * REACHABILITY: walk the dependency graph from the root manifest and each
 * workspace manifest, following the same edges npm follows and resolving names
 * the way npm resolves them (nearest `node_modules`, then up the ancestors).
 * A package is required only if some path to it uses no optional edge. Absence
 * is then allowed for anything optional, anything the lockfile itself flags
 * `optional`, and anything whose `os`/`cpu`/`libc` rules out this machine.
 *
 * The walk errs deliberately toward under-marking. A package it fails to mark
 * required is one this check will not notice going missing — a smaller failure
 * than a false alarm on a healthy tree, and one the gate's other steps still
 * catch the old, slow way.
 *
 * ## Speed
 *
 * It reads the lockfile and, in this repo, 1,341 small `package.json` files,
 * measured at ~95ms end to end on a 10-core laptop. That is cheap enough to run
 * as a *preflight* rather than a step: scripts/run-gate.mjs runs it before it
 * schedules anything, and a failure stops the gate there instead of spending
 * 83s producing a failure that points somewhere else.
 *
 * Runs as a preflight in `npm run verify` (scripts/run-gate.mjs), as
 * `npm run deps:check` on its own, and in CI's Lint job — where it is expected
 * always to pass, which is the point: CI is what proves this checker still
 * works against a tree `npm ci` has just written.
 */
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** How many `package.json` reads to have in flight at once. */
const READ_CONCURRENCY = 64;

/** Failures listed in full before collapsing to a count. */
const MAX_LISTED = 12;

// ---------------------------------------------------------------------------
// npm's resolution rules, as much of them as this needs
// ---------------------------------------------------------------------------

/**
 * True when a lockfile entry's `os`/`cpu` allow this machine. npm skips
 * packages that fail this, so their absence is correct, not stale.
 *
 * A `libc` constraint is treated as "cannot tell from here" and allowed to be
 * absent: this process cannot reliably distinguish glibc from musl, and a
 * wrong guess here is a false alarm on a healthy tree.
 */
function installableHere(entry) {
  const matches = (list, actual) => {
    if (!Array.isArray(list) || list.length === 0) return true;
    const allowed = list.filter((v) => !v.startsWith('!'));
    const blocked = list.filter((v) => v.startsWith('!')).map((v) => v.slice(1));
    if (blocked.includes(actual)) return false;
    return allowed.length === 0 || allowed.includes(actual);
  };
  if (entry.libc) return false;
  return matches(entry.os, process.platform) && matches(entry.cpu, process.arch);
}

/**
 * Resolves `name` as required from the package at lockfile path `from`, the way
 * node does: the nearest `node_modules` first, then each ancestor's, ending at
 * the root's. Returns the lockfile path of the node that would be found, or
 * null if the lockfile places none.
 */
function resolveFrom(from, name, packages) {
  let base = from;
  for (;;) {
    const candidate = base === '' ? `node_modules/${name}` : `${base}/node_modules/${name}`;
    if (Object.hasOwn(packages, candidate)) return candidate;
    if (base === '') return null;
    const at = base.lastIndexOf('/node_modules/');
    base = at === -1 ? '' : base.slice(0, at);
  }
}

/** A workspace link node (`node_modules/frontend` -> `frontend`) redirects. */
function deref(path, packages) {
  const entry = packages[path];
  if (entry?.link && typeof entry.resolved === 'string') return entry.resolved;
  return path;
}

/**
 * Walks the lockfile's dependency graph and returns the set of lockfile paths
 * reachable without traversing an optional edge — the packages that must be on
 * disk for the tree to be the one the lockfile describes.
 *
 * Only the root and workspace manifests contribute `devDependencies`: npm does
 * not install a transitive package's dev dependencies, and treating them as
 * required would be exactly the over-marking that produces false alarms.
 */
function requiredPaths(packages, manifests) {
  const roots = [...manifests.keys()];
  const required = new Set();
  const seenOptional = new Set();
  const unlocked = [];
  /** @type {{path: string, required: boolean}[]} */
  const queue = roots.map((path) => ({ path, required: true }));

  while (queue.length > 0) {
    const { path, required: isRequired } = queue.pop();
    // For the root and the workspaces, the requirement is what package.json
    // declares TODAY, not the copy of it the lockfile recorded. Those drift:
    // this repo's lockfile still carried `husky` in the root devDependencies
    // long after #544 removed it, and reading the lockfile's copy made an
    // orphan that npm correctly never installs look like a stale install.
    const entry = manifests.get(path) ?? packages[path];
    if (!entry) continue;

    if (isRequired) {
      if (required.has(path)) continue;
      required.add(path);
    } else {
      if (required.has(path) || seenOptional.has(path)) continue;
      seenOptional.add(path);
    }

    const isManifest = manifests.has(path);
    const edges = new Map();
    const add = (deps, optional) => {
      for (const name of Object.keys(deps ?? {})) {
        // A name reached both ways keeps the stronger (non-optional) claim.
        if (!edges.has(name) || !optional) edges.set(name, optional);
      }
    };
    add(entry.dependencies, false);
    if (isManifest) add(entry.devDependencies, false);
    add(entry.peerDependencies, false);
    // npm: "entries in optionalDependencies override entries of the same name
    // in dependencies", and an optional peer is optional however it was named.
    // Both therefore overwrite rather than losing to the `add` rule above.
    for (const name of Object.keys(entry.optionalDependencies ?? {})) edges.set(name, true);
    for (const [name, meta] of Object.entries(entry.peerDependenciesMeta ?? {})) {
      if (meta?.optional) edges.set(name, true);
    }

    for (const [name, optionalEdge] of edges) {
      const found = resolveFrom(path, name, packages);
      if (!found) {
        // A dependency a manifest declares that the lockfile places NOWHERE is
        // a different fault: the lockfile is behind package.json, and `npm ci`
        // will refuse the tree outright. Worth naming, and worth naming apart,
        // because the remedy is `npm install` rather than `npm ci`.
        if (isManifest && !optionalEdge) unlocked.push({ manifest: path, name });
        continue;
      }
      const target = deref(found, packages);
      queue.push({ path: target, required: isRequired && !optionalEdge });
    }
  }

  // The manifests themselves are source, not installed packages.
  for (const root of roots) {
    required.delete(root);
    seenOptional.delete(root);
  }
  return { required, optional: seenOptional, unlocked };
}

// ---------------------------------------------------------------------------
// the check
// ---------------------------------------------------------------------------

/**
 * @typedef {object} FreshnessReport
 * @property {boolean}  ok         Whether the installed tree matches the lock.
 * @property {string[]} problems   Human-readable lines; empty when ok.
 * @property {number}   checked    Packages whose version was verified on disk.
 * @property {string}   [headline] One-line summary of what is wrong.
 */

/**
 * Compares `node_modules` against `package-lock.json` for `root`.
 *
 * Never throws for an ordinary "things are missing" answer — that is a report
 * with `ok: false`. It DOES throw when it cannot perform the comparison at all
 * (no lockfile, unreadable lockfile, a workspace the lockfile does not know
 * about), because a check that cannot check must not return a pass.
 *
 * @param {string} root Repository root.
 * @returns {Promise<FreshnessReport>}
 */
export async function checkDependencyFreshness(root = join(HERE, '..')) {
  const lockPath = join(root, 'package-lock.json');
  if (!existsSync(lockPath)) {
    throw new Error(
      `${lockPath} does not exist, so there is nothing to compare node_modules against. ` +
        `This check cannot report a pass it did not make.`
    );
  }

  let lock;
  try {
    lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch (err) {
    throw new Error(`package-lock.json could not be parsed: ${err.message}`, { cause: err });
  }
  const packages = lock.packages;
  if (!packages || typeof packages !== 'object') {
    throw new Error(
      `package-lock.json has no \`packages\` map (lockfileVersion ${lock.lockfileVersion ?? '?'}). ` +
        `This check needs lockfileVersion 2 or later; run \`npm install\` with npm 7+.`
    );
  }

  // Not installed at all. `.package-lock.json` is npm's own install marker,
  // written by a completed install and by nothing else — the same signal
  // .githooks/pre-push uses (#544).
  if (
    !existsSync(join(root, 'node_modules')) ||
    !existsSync(join(root, 'node_modules', '.package-lock.json'))
  ) {
    return {
      ok: false,
      checked: 0,
      headline: 'dependencies are not installed in this working tree',
      problems: [
        'There is no completed npm install here — `node_modules/.package-lock.json`,',
        'which npm writes at the end of an install and nothing else writes, is absent.',
        '',
        'This is the usual state of a freshly created `git worktree add`: worktrees do',
        'not share node_modules with the checkout they were made from.',
      ],
    };
  }

  // The lockfile is one tree spanning the root and every workspace. If it does
  // not know about a workspace, it is older than package.json and no comparison
  // it supports means anything.
  const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const manifests = new Map([['', rootManifest]]);
  for (const workspace of rootManifest.workspaces ?? []) {
    if (!Object.hasOwn(packages, workspace)) {
      throw new Error(
        `package-lock.json has no entry for workspace \`${workspace}\`, which package.json declares. ` +
          `The lockfile predates the workspace; run \`npm install\` and commit the result.`
      );
    }
    manifests.set(
      workspace,
      JSON.parse(readFileSync(join(root, workspace, 'package.json'), 'utf8'))
    );
  }

  const { required, optional, unlocked } = requiredPaths(packages, manifests);

  const missing = [];
  const wrongVersion = [];
  let checked = 0;

  // Everything the walk reached, required or not. Optional packages cannot be
  // *required* to exist, but when they DO exist they must still be at the
  // pinned version — so they are checked, with absence allowed.
  const targets = [...new Set([...required, ...optional])]
    .filter((path) => {
      const entry = packages[path];
      return Boolean(entry) && !entry.link;
    })
    .map((path) => ({
      path,
      // npm's own verdict wins over the walk's: an entry it flags `optional`,
      // or one this machine's os/cpu rules out, may legitimately be absent.
      mustExist: required.has(path) && !packages[path].optional && installableHere(packages[path]),
    }));

  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= targets.length) return;
      const { path, mustExist } = targets[index];
      const entry = packages[path];
      let installed;
      try {
        installed = JSON.parse(await readFile(join(root, path, 'package.json'), 'utf8'));
      } catch {
        if (mustExist) missing.push({ path, want: entry.version });
        continue;
      }
      checked += 1;
      if (entry.version && installed.version && installed.version !== entry.version) {
        wrongVersion.push({ path, want: entry.version, have: installed.version });
      }
    }
  };
  await Promise.all(Array.from({ length: READ_CONCURRENCY }, worker));

  if (missing.length === 0 && wrongVersion.length === 0 && unlocked.length === 0) {
    return { ok: true, checked, problems: [] };
  }

  const name = (path) => path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
  const byPath = (a, b) => a.path.localeCompare(b.path);
  const problems = [];

  if (missing.length > 0) {
    missing.sort(byPath);
    problems.push(
      `${missing.length} package${missing.length === 1 ? '' : 's'} the lockfile requires ${
        missing.length === 1 ? 'is' : 'are'
      } NOT INSTALLED:`
    );
    for (const m of missing.slice(0, MAX_LISTED)) {
      problems.push(`  ${name(m.path)}@${m.want ?? '?'}  (${m.path})`);
    }
    if (missing.length > MAX_LISTED) {
      problems.push(`  … and ${missing.length - MAX_LISTED} more`);
    }
    problems.push(
      '',
      'These landed in commits this tree has but never installed. Every suite, lint',
      'and typecheck that imports one of them will fail on module resolution, and none',
      'of those failures is about your code.'
    );
  }

  if (wrongVersion.length > 0) {
    if (missing.length > 0) problems.push('');
    wrongVersion.sort(byPath);
    problems.push(
      `${wrongVersion.length} package${wrongVersion.length === 1 ? '' : 's'} ${
        wrongVersion.length === 1 ? 'is' : 'are'
      } installed at a version the lockfile does not pin:`
    );
    for (const w of wrongVersion.slice(0, MAX_LISTED)) {
      problems.push(`  ${name(w.path)}  have ${w.have}, lockfile pins ${w.want}  (${w.path})`);
    }
    if (wrongVersion.length > MAX_LISTED) {
      problems.push(`  … and ${wrongVersion.length - MAX_LISTED} more`);
    }
    problems.push(
      '',
      'The lockfile moved under a tree installed from an older one, or something ran',
      '`npm install <pkg>` here. Behaviour on this machine is not the behaviour CI',
      'and production get from the lockfile.'
    );
  }

  if (unlocked.length > 0) {
    if (problems.length > 0) problems.push('');
    problems.push(
      `${unlocked.length} dependenc${unlocked.length === 1 ? 'y is' : 'ies are'} declared in a ` +
        `package.json that package-lock.json does not resolve:`
    );
    for (const u of unlocked.slice(0, MAX_LISTED)) {
      problems.push(
        `  ${u.name}  (declared by ${u.manifest === '' ? 'package.json' : `${u.manifest}/package.json`})`
      );
    }
    if (unlocked.length > MAX_LISTED) {
      problems.push(`  … and ${unlocked.length - MAX_LISTED} more`);
    }
    problems.push(
      '',
      'Here the LOCKFILE is the stale one, so `npm ci` will refuse this tree outright.',
      'Run `npm install` to update package-lock.json, and commit it.'
    );
  }

  const parts = [];
  if (missing.length > 0) parts.push(`${missing.length} missing`);
  if (wrongVersion.length > 0) parts.push(`${wrongVersion.length} at the wrong version`);
  if (unlocked.length > 0) parts.push(`${unlocked.length} not in the lockfile`);

  return {
    ok: false,
    checked,
    // `npm ci` is the remedy for a stale tree; it is the wrong one for a stale
    // lockfile, which npm itself will reject. Say which this is.
    remedy:
      unlocked.length > 0 && missing.length === 0 && wrongVersion.length === 0
        ? 'npm install'
        : 'npm ci',
    headline: `node_modules does not match package-lock.json (${parts.join(', ')})`,
    problems,
  };
}

/** Renders a failed report as the block both the CLI and the gate print. */
export function formatFreshnessFailure(report) {
  const remedy = report.remedy ?? 'npm ci';
  return [
    `dependencies: ${report.headline}`,
    '',
    ...report.problems,
    '',
    remedy === 'npm ci'
      ? 'This is a stale install, not a broken change. Fix it with:'
      : 'This is a stale lockfile, not a broken change. Fix it with:',
    '',
    `  ${remedy}`,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  try {
    const report = await checkDependencyFreshness();
    if (report.ok) {
      console.log(
        `dependencies: node_modules matches package-lock.json (${report.checked} packages verified).`
      );
      process.exitCode = 0;
    } else {
      console.error(formatFreshnessFailure(report));
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`dependencies: check could not run — ${err.message}`);
    process.exitCode = 1;
  }
}
