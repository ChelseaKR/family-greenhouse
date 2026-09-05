#!/usr/bin/env node
/**
 * Points this clone's `core.hooksPath` at the TRACKED `.githooks/` directory.
 *
 * Runs as package.json's `prepare` script, so `npm ci` / `npm install` wires
 * the hooks the same way husky's `prepare: husky` used to — but at a path that
 * is committed rather than generated.
 *
 * ## Why (#544)
 *
 * husky sets `core.hooksPath=.husky/_`. That shim directory is produced by
 * `npm install` and is git-ignored (husky writes a `*` .gitignore into it).
 * Worktrees share `.git/config`, so `git worktree add` inherits the hooksPath
 * while the directory it names does not exist in the new worktree. Git looks
 * for `.husky/_/pre-push`, finds nothing, and pushes — exit 0, no warning.
 *
 * The absence of a directory was rendered as a clean push, on the one
 * mechanism that enforces every other rule in this repo. `--no-verify` is at
 * least loud; this was silent and was reached by an ordinary `worktree add`.
 *
 * A tracked directory cannot be absent: `git clone`, `git checkout` and
 * `git worktree add` all materialise `.githooks/pre-push` by construction. The
 * one thing that CAN still be missing in a new worktree is `node_modules`, and
 * the hook itself refuses the push in that case rather than half-running.
 *
 * ## Failure policy
 *
 * This script never "succeeds quietly at doing nothing" except in the single
 * case where there is genuinely no git repository to configure (installing the
 * package from a tarball, a Docker build stage that copied only package.json).
 * Every other problem — a missing hook file, a hook that is not executable, a
 * `git config` that did not take — exits non-zero and fails the install, so a
 * broken wiring is discovered at `npm ci` rather than at the first ungated
 * push.
 *
 * The wiring is re-asserted on every gate run by scripts/check-git-hooks.mjs,
 * which is the check that catches drift introduced after install time.
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HOOKS_DIR, REQUIRED_HOOKS } from './git-hooks-config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function git(args) {
  return spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

function fail(message) {
  console.error(`install-git-hooks: ${message}`);
  process.exit(1);
}

// --- 1. Is there a git repository to configure at all? ----------------------

const insideRepo = git(['rev-parse', '--git-dir']);
if (insideRepo.error || insideRepo.status !== 0) {
  // Not a git checkout. This is the ONLY tolerated no-op: there is no
  // `core.hooksPath` to set, and no push can originate here either, so
  // nothing is left unprotected by skipping.
  console.log(
    'install-git-hooks: not a git repository — skipping hook wiring (nothing to protect here).'
  );
  process.exit(0);
}

// --- 2. The hooks themselves must be present and runnable -------------------

for (const hook of REQUIRED_HOOKS) {
  const path = join(ROOT, HOOKS_DIR, hook);
  if (!existsSync(path)) {
    fail(
      `${HOOKS_DIR}/${hook} is missing. It is a tracked file, so this means the working tree is\n` +
        '  damaged or the file was deleted — restore it with `git checkout -- ' +
        `${HOOKS_DIR}/${hook}\`.`
    );
  }
  try {
    accessSync(path, constants.X_OK);
  } catch {
    fail(
      `${HOOKS_DIR}/${hook} is not executable. Git silently ignores a non-executable hook, which\n` +
        '  is exactly the failure this directory exists to prevent. Fix with:\n' +
        `    chmod +x ${HOOKS_DIR}/${hook} && git update-index --chmod=+x ${HOOKS_DIR}/${hook}`
    );
  }
}

// --- 3. Point git at them ---------------------------------------------------

const set = git(['config', 'core.hooksPath', HOOKS_DIR]);
if (set.status !== 0) {
  fail(`\`git config core.hooksPath ${HOOKS_DIR}\` failed:\n${set.stderr || set.stdout}`);
}

// --- 4. Read it back. A write that did not take must not look like success. --

const readBack = git(['config', '--get', 'core.hooksPath']);
const value = (readBack.stdout ?? '').trim();
if (value !== HOOKS_DIR) {
  fail(
    `core.hooksPath is ${value === '' ? '(unset)' : `\`${value}\``} after being set to ` +
      `\`${HOOKS_DIR}\`.\n` +
      '  Something else is overriding it (a system/global config, or another `prepare` step).\n' +
      '  Git hooks are NOT wired; pushes from this checkout would not run the gate.'
  );
}

console.log(`install-git-hooks: core.hooksPath -> ${HOOKS_DIR} (tracked; survives worktree add).`);
