/**
 * The tracked-git-hooks contract, as data. NO SIDE EFFECTS — that is the whole
 * point of this file existing separately from scripts/install-git-hooks.mjs.
 *
 * check-git-hooks.mjs originally imported these constants from the installer.
 * Importing the installer RUNS it, so the checker re-wired `core.hooksPath`
 * on the way to inspecting it: a deliberately broken hooksPath was silently
 * repaired and then reported as correct. The check could not fail for the one
 * defect it was written to catch (#544) — the same "gate that cannot fail"
 * shape as the bug it guards. Constants live here so the checker can observe
 * the world without changing it.
 */

/** The tracked hooks directory, relative to the worktree root. */
export const HOOKS_DIR = '.githooks';

/** Hooks that must exist and be executable for the wiring to be complete. */
export const REQUIRED_HOOKS = ['pre-commit', 'commit-msg', 'pre-push'];

/**
 * The committed SSH allowed-signers file, relative to the worktree root.
 *
 * Kept relative on purpose: `git config` stores this string verbatim, so an
 * absolute path would be baked into whichever directory the clone happened to
 * live in and would break the moment the repo moved or was cloned elsewhere.
 */
export const ALLOWED_SIGNERS_FILE = '.github/allowed_signers';

/** The git config key that points at it. */
export const ALLOWED_SIGNERS_KEY = 'gpg.ssh.allowedSignersFile';
