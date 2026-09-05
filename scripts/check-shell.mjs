#!/usr/bin/env node
/**
 * Runs shellcheck over every shell script this repository tracks (#443).
 *
 * ## Why
 *
 * Nothing checked them. `eslint` is scoped to `src`, `tsc` never sees a `.sh`,
 * and prettier does not format shell. Five scripts, and one of them —
 * `.github/scripts/purge-frontend-snapshot-versions.sh` — deletes S3 object
 * versions on the production release path.
 *
 * ## The file list is derived, not written down
 *
 * `git ls-files '*.sh'` rather than a hardcoded array. A hardcoded list is a
 * gate that silently stops covering the next script somebody adds, which is
 * the same shape as the defects this repo keeps finding in its own tooling. It
 * also means the check FAILS when it finds nothing to check: an empty list and
 * a clean run are indistinguishable at the exit code, so they are distinguished
 * here.
 *
 * ## What switching it on found
 *
 * `frontend/scripts/build-mobile-release.sh` carried
 *
 *     # shellcheck disable=SC1090 -- the caller intentionally selects this file
 *
 * The `-- reason` suffix is ESLint's syntax, not shellcheck's. shellcheck
 * cannot parse the directive (SC1073/SC1072) and — measured, not assumed —
 * stops reporting anything else in that file. A synthetic control: a file
 * containing the malformed directive plus `rm -rf $UNQUOTED_VAR/subdir` reports
 * only the two directive errors; the same file with a well-formed directive
 * reports SC2086 on the `rm`. A suppression that blinds the rest of the file,
 * in a repo whose shell scripts delete S3 objects.
 *
 * Runs in CI's required Lint job and in `npm run verify` — the same both-places
 * pattern as check-no-bare-markers.mjs (CICD-27).
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = process.env.SHELLCHECK_BIN || 'shellcheck';

function fail(lines) {
  for (const line of lines) console.error(line);
  process.exit(1);
}

// --- The tool must be present ----------------------------------------------

const version = spawnSync(BIN, ['--version'], { encoding: 'utf8' });
if (version.error || version.status !== 0) {
  fail([
    'check-shell: shellcheck is not installed, so the shell scripts cannot be checked.',
    '',
    'A hard failure on purpose: a check that skips itself when its tool is missing is',
    'a gate that cannot fail (#443), and one of the scripts it covers deletes S3',
    'object versions on the production release path. Install it:',
    '',
    '  brew install shellcheck',
    '  apt-get install -y shellcheck',
    '  bash scripts/setup-dev.sh',
    '',
    'Or point this at an existing binary:  SHELLCHECK_BIN=/path/to/shellcheck npm run verify',
  ]);
}

// --- The file list, derived from git ---------------------------------------

const listed = spawnSync('git', ['ls-files', '-z', '*.sh'], { cwd: ROOT, encoding: 'utf8' });
if (listed.error || listed.status !== 0) {
  fail([
    'check-shell: could not list tracked shell scripts with `git ls-files`.',
    'Refusing to report a pass on a file list this script could not build.',
    `${listed.stderr ?? ''}`,
  ]);
}

const files = (listed.stdout ?? '').split('\0').filter(Boolean);

if (files.length === 0) {
  fail([
    'check-shell: `git ls-files "*.sh"` matched no files.',
    '',
    'That is either a repository with no shell scripts — in which case delete this',
    'check rather than leaving one that passes vacuously — or a broken invocation.',
    'Either way it is not the same thing as "the shell scripts are clean".',
  ]);
}

// --- Check them ------------------------------------------------------------

const run = spawnSync(BIN, [...files], { cwd: ROOT, encoding: 'utf8' });
const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;

if (run.error) {
  fail([`check-shell: could not run shellcheck: ${run.error.message}`]);
}

if (run.status !== 0) {
  console.error(
    `shellcheck reported problems in ${files.length} tracked shell script(s).\n\n` +
      'A note on suppressions: shellcheck directives take no `-- reason` suffix (that is\n' +
      "ESLint's syntax). A malformed directive is not a no-op — it stops shellcheck\n" +
      'reporting anything else in that file. Write the reason on its own comment line\n' +
      'above the directive.\n'
  );
  console.error(output);
  console.error(`  reproduce: ${BIN} ${files.join(' ')}`);
  process.exit(run.status ?? 1);
}

console.log(`shellcheck clean across ${files.length} tracked shell script(s): ${files.join(', ')}`);
