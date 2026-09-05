#!/usr/bin/env node
/**
 * Asserts that the local git hooks are actually wired — that the mechanism
 * which enforces every other gate is itself present, tracked, executable and
 * pointed at.
 *
 * ## Why this check exists (#544)
 *
 * `core.hooksPath` was `.husky/_`: a directory husky GENERATES during
 * `npm install` and git-ignores. Worktrees share `.git/config`, so a
 * `git worktree add` inherited that path into a tree where the directory did
 * not exist. Git found no hook, ran no hook, and pushed. Exit 0, six lines of
 * output, no warning — the absence of a directory rendered as a clean push.
 *
 * The fix is `.githooks/`, a tracked directory. But "the fix is in place" is a
 * claim, and an unverified claim about a gate is how this class of defect
 * survives. So the wiring is re-derived from git itself on every gate run:
 *
 *   1. `core.hooksPath` is set, and names the tracked hooks directory.
 *   2. That directory exists in THIS working tree.
 *   3. Every required hook exists there and is executable on disk. (Git
 *      silently ignores a non-executable hook — another absence that renders
 *      as a pass.)
 *   4. Every required hook is TRACKED, with git's executable mode bit set in
 *      the index. This is the property that makes the hook un-absent in the
 *      next `git worktree add`: a file that is only executable on one laptop
 *      protects only that laptop.
 *   5. `pre-push` still invokes `npm run verify`. A hook that exists but no
 *      longer runs the gate is the same hole with extra steps.
 *   6. package.json's `prepare` still runs the installer, so the next
 *      `npm install` cannot silently re-point `core.hooksPath` at a generated
 *      directory the way `prepare: husky` did.
 *
 * ## What it deliberately does NOT do
 *
 * It does not pass when git is unavailable or the tree is not a repository.
 * "I could not check" is not "it is fine" — that equivalence is the bug this
 * whole file is about. `npm run verify` runs inside a git checkout by
 * definition (pre-push calls it), so a hard failure here is a real signal.
 *
 * Runs in `npm run verify` (scripts/gate-steps.mjs) and in CI's Lint job — the
 * same both-places pattern as check-no-bare-markers.mjs (CICD-27).
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// NOT from install-git-hooks.mjs: importing the installer RUNS it, which repaired a
// broken core.hooksPath on the way to inspecting it and made this check unable to
// fail for its own headline case. Constants live in a side-effect-free module.
import { HOOKS_DIR, REQUIRED_HOOKS } from './git-hooks-config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];

function git(args) {
  return spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

// --- 0. There must be a repository to inspect -------------------------------

const gitDir = git(['rev-parse', '--git-dir']);
if (gitDir.error || gitDir.status !== 0) {
  console.error(
    'check-git-hooks: not a git repository (or `git` is unavailable), so the pre-push wiring\n' +
      'cannot be verified. Refusing to report a pass — an unverifiable gate is the defect this\n' +
      'check exists to catch (#544).'
  );
  process.exit(1);
}

// --- 1/2. core.hooksPath is set and names the tracked directory -------------

const configured = (git(['config', '--get', 'core.hooksPath']).stdout ?? '').trim();

if (configured === '') {
  errors.push(
    'core.hooksPath is unset, so git falls back to `.git/hooks` — which holds only the sample\n' +
      '  hooks and runs nothing. Wire it with `npm run hooks:install`.'
  );
} else if (configured !== HOOKS_DIR) {
  errors.push(
    `core.hooksPath is \`${configured}\`, not \`${HOOKS_DIR}\`.\n` +
      "  If that path is generated rather than tracked (husky's `.husky/_` was), a fresh\n" +
      '  `git worktree add` will find nothing there and push with no gate at all (#544).\n' +
      '  Re-wire with `npm run hooks:install`.'
  );
}

const hooksDirAbs = resolve(ROOT, HOOKS_DIR);
if (!existsSync(hooksDirAbs) || !statSync(hooksDirAbs).isDirectory()) {
  errors.push(
    `${HOOKS_DIR}/ does not exist in this working tree. It is tracked, so this means it was\n` +
      '  deleted — restore it with `git checkout -- ' +
      `${HOOKS_DIR}\`.`
  );
}

// --- 3/4. Each hook: present, executable on disk, tracked as executable -----

/** `git ls-files -s` mode for a path, or null when the path is untracked. */
function indexMode(relPath) {
  const listed = git(['ls-files', '-s', '--', relPath]);
  if (listed.status !== 0) return null;
  const line = (listed.stdout ?? '').trim();
  if (line === '') return null;
  return line.split(/\s+/)[0];
}

for (const hook of REQUIRED_HOOKS) {
  const rel = `${HOOKS_DIR}/${hook}`;
  const abs = join(ROOT, rel);

  if (!existsSync(abs)) {
    errors.push(`${rel} is missing — git would silently run no ${hook} hook.`);
    continue;
  }

  try {
    accessSync(abs, constants.X_OK);
  } catch {
    errors.push(
      `${rel} is not executable on disk. Git skips a non-executable hook WITHOUT reporting\n` +
        '  anything, so the gate would be off while looking installed. Fix:\n' +
        `    chmod +x ${rel}`
    );
  }

  const mode = indexMode(rel);
  if (mode === null) {
    errors.push(
      `${rel} is not tracked by git. An untracked hook protects only the machine it was\n` +
        '  written on — the next `git clone` or `git worktree add` gets nothing (#544). Fix:\n' +
        `    git add ${rel}`
    );
  } else if (mode !== '100755') {
    errors.push(
      `${rel} is tracked with mode ${mode}, not 100755. Git checks the file out\n` +
        '  non-executable in every other clone and worktree, and then skips it silently. Fix:\n' +
        `    git update-index --chmod=+x ${rel}`
    );
  }
}

// --- 5. pre-push still runs the gate ----------------------------------------

const prePushPath = join(ROOT, HOOKS_DIR, 'pre-push');
if (existsSync(prePushPath)) {
  const prePush = readFileSync(prePushPath, 'utf8');
  const live = prePush
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
  if (!live.includes('npm run verify')) {
    errors.push(
      `${HOOKS_DIR}/pre-push no longer runs \`npm run verify\`. The hook is installed and does\n` +
        '  not run the gate, which is indistinguishable from no hook at all.'
    );
  }
  if (!live.includes('node_modules')) {
    errors.push(
      `${HOOKS_DIR}/pre-push no longer checks for installed dependencies. A fresh worktree\n` +
        '  would run the gate against absent tooling instead of refusing the push (#544).'
    );
  }
}

// --- 6. `prepare` still re-wires hooksPath on install -----------------------

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const prepare = pkg.scripts?.prepare ?? '';
if (!prepare.includes('install-git-hooks.mjs')) {
  errors.push(
    `package.json \`prepare\` is \`${prepare}\`, which does not run scripts/install-git-hooks.mjs.\n` +
      "  `prepare` runs on every `npm install`, so whatever it sets wins. husky's `prepare`\n" +
      '  re-pointed core.hooksPath at the generated `.husky/_` every time — a fix that does not\n' +
      '  survive `prepare` does not survive at all (#544).'
  );
}

if (errors.length > 0) {
  console.error(
    'Local git hooks are not wired the way the repo claims. The pre-push gate is the mechanism\n' +
      'that enforces every other rule, so a hole here is not one missing check — it is all of\n' +
      'them (#544):\n'
  );
  for (const error of errors) console.error(`  ${error}\n`);
  process.exit(1);
}

console.log(
  `Git hooks wired: core.hooksPath=${HOOKS_DIR} (tracked), ` +
    `${REQUIRED_HOOKS.join(', ')} present + executable in the index, ` +
    'pre-push runs `npm run verify`.'
);
