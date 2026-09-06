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
 * Every problem with the HOOK WIRING — a missing hook file, a hook that is not
 * executable, a `git config` that did not take — exits non-zero and fails the
 * install, so a broken wiring is discovered at `npm ci` rather than at the
 * first ungated push.
 *
 * Step 5 (`gpg.ssh.allowedSignersFile`, #582) is the one deliberate exception
 * and warns instead of exiting. It configures local `git tag -v` output, not
 * whether a push is gated, so nothing reaches origin unchecked if it fails.
 * It is still announced on stdout/stderr, so it is not a quiet no-op.
 *
 * The wiring is re-asserted on every gate run by scripts/check-git-hooks.mjs,
 * which is the check that catches drift introduced after install time.
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALLOWED_SIGNERS_FILE,
  ALLOWED_SIGNERS_KEY,
  HOOKS_DIR,
  REQUIRED_HOOKS,
} from './git-hooks-config.mjs';

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

// --- 5. Local tag verification (#582) ---------------------------------------
//
// `git tag -v v0.28.0` fails in a fresh clone with
//
//   error: gpg.ssh.allowedSignersFile needs to be configured and exist for
//   ssh signature verification
//
// on a tag whose signature is perfectly good. The key is committed at
// `.github/allowed_signers`; git simply has no default that would find a file
// the repo already tracks. CI never hit this because
// `.github/workflows/cd-production.yml` sets the config inline before
// verifying, so the AUTO-GATE in RELEASE-AND-VERSIONING-STANDARD.md works
// while the local terminal does not.
//
// This is a FALSE NEGATIVE, not a silent pass. Measured on this repo:
// unconfigured, `git tag -v` exits 1; configured and valid, it exits 0. Git
// prints the tag body first and the error afterwards, which is what makes it
// look like it succeeded if you only read the terminal — but it fails closed,
// so nothing scripted around the exit code is unsafe today. What it costs is a
// maintainer being told a real release failed verification, on the one command
// whose whole job is to tell a good signature from a bad one.
//
// ## Why this is a WARNING and not a `fail()`
//
// Everything above this line is push-gate wiring: if it is wrong, ungated code
// reaches origin, so it exits non-zero. This is a local convenience for a
// command most contributors never run. Failing `npm ci` over it would be
// disproportionate — and it is announced either way, so it is not this
// script's "succeed quietly at doing nothing" case.
//
// ## Why it does not overwrite an existing value
//
// A developer may point this key at a personal allowed-signers file covering
// many repos. Clobbering that on every `npm ci` would be its own defect, so an
// existing different value is reported and left alone.

const signersPath = join(ROOT, ALLOWED_SIGNERS_FILE);

if (!existsSync(signersPath)) {
  // Tracked file, so this means a damaged worktree rather than a normal state.
  console.warn(
    `install-git-hooks: ${ALLOWED_SIGNERS_FILE} is missing, so ${ALLOWED_SIGNERS_KEY} was not set.\n` +
      '  It is a tracked file — restore it with `git checkout -- ' +
      `${ALLOWED_SIGNERS_FILE}\`. Until then \`git tag -v\` will report a` +
      ' configuration error on valid tags.'
  );
} else {
  const existing = git(['config', '--get', ALLOWED_SIGNERS_KEY]);
  const current = (existing.stdout ?? '').trim();

  if (current !== '' && current !== ALLOWED_SIGNERS_FILE) {
    console.log(
      `install-git-hooks: ${ALLOWED_SIGNERS_KEY} is already set to \`${current}\` — left as is.\n` +
        `  If \`git tag -v\` rejects this repo's release tags, point it at ` +
        `\`${ALLOWED_SIGNERS_FILE}\` instead.`
    );
  } else {
    const setSigners = git(['config', ALLOWED_SIGNERS_KEY, ALLOWED_SIGNERS_FILE]);
    // Read back for the same reason as core.hooksPath above: a write that did
    // not take must not be reported as success.
    const signersReadBack = git(['config', '--get', ALLOWED_SIGNERS_KEY]);

    if (setSigners.status !== 0 || (signersReadBack.stdout ?? '').trim() !== ALLOWED_SIGNERS_FILE) {
      console.warn(
        `install-git-hooks: could not set ${ALLOWED_SIGNERS_KEY} -> ${ALLOWED_SIGNERS_FILE}.\n` +
          '  Not fatal — hooks are wired and pushes are gated — but `git tag -v` will report a\n' +
          '  configuration error on valid release tags. Set it by hand with:\n' +
          `    git config ${ALLOWED_SIGNERS_KEY} ${ALLOWED_SIGNERS_FILE}`
      );
    } else {
      console.log(
        `install-git-hooks: ${ALLOWED_SIGNERS_KEY} -> ${ALLOWED_SIGNERS_FILE} ` +
          '(repo-local; `git tag -v` now verifies signed tags).'
      );
    }
  }
}
