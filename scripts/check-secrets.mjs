#!/usr/bin/env node
/**
 * Secret scanning, run the same way locally and in CI (#442).
 *
 * ## The hole this closes
 *
 * `ci.yml` ran exactly one gitleaks command:
 *
 *   gitleaks detect --source . --config .gitleaks.toml --redact --no-banner
 *
 * With no `--no-git`, gitleaks runs in GIT mode: it walks commits and scans
 * PATCHES, not the files as they exist on disk. That is the right thing to do —
 * a secret committed and then removed still needs to be caught — but it is an
 * argument for running history mode AS WELL AS file mode, not instead of it.
 *
 * Measured with gitleaks 8.30.1 (the version this repo pins), one fresh
 * throwaway repo per scenario so no earlier commit contaminates the result:
 *
 *   scenario                                      history    --no-git
 *   ------------------------------------------    -------    --------
 *   committed plain text file (control)           FAIL (1)   FAIL (1)
 *   secret only in an uncommitted working edit    PASS (0)   FAIL (1)
 *   secret in an untracked file on disk           PASS (0)   FAIL (1)
 *   secret in a gitignored file on disk           PASS (0)   FAIL (1)
 *   secret introduced only in a merge resolution  PASS (0)   FAIL (1)
 *   secret in a file `.gitattributes` marks       PASS (0)   FAIL (1)
 *     as binary
 *
 * Two of those bite in CI as well as locally: a merge commit's resolution is
 * invisible to the commit walk, and so is any file git diffs as binary. The
 * other three are the difference between a `verify` run and a CI run, which is
 * why `verify` needs this and why it needs BOTH modes.
 *
 * Not reproduced: a secret hidden in genuinely binary content (NUL bytes). Both
 * modes skip it. The `.gitattributes binary` case above is a text file git has
 * been TOLD to diff as binary, and that one really is history-mode-only.
 *
 * ## Why one script instead of two workflow steps
 *
 * The two modes are separate spawns with separately checked exit codes — never
 * a shell pipeline, which reports only the last stage's status. Putting them
 * here rather than in ci.yml means the flags cannot drift between local and CI:
 * the same both-places pattern as check-no-bare-markers.mjs (CICD-27). CI
 * passes GITLEAKS_BIN so the pinned downloaded binary is used.
 *
 * ## Why a missing binary is a FAILURE here
 *
 * `.githooks/pre-commit` soft-skips when gitleaks is absent, deliberately, so a
 * fresh clone's first commit is not blocked. The problem the issue names is
 * that there was then NO signal anywhere that the gate was off — a contributor
 * could work for months believing they were covered. A `verify` step that
 * skipped itself would be a fourth such signal-free hole, and a check that
 * cannot fail is the defect this repo keeps finding in its own tooling. So this
 * one refuses to run rather than pretending. `scripts/setup-dev.sh` installs
 * the binary; the failure message says how to do it by hand.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = '.gitleaks.toml';

/**
 * The version CI downloads and `.pre-commit-config.yaml` pins. Asserted against
 * ci.yml below, so the three cannot drift apart silently — different gitleaks
 * versions carry different rules, which would make local and CI disagree about
 * what a secret is.
 */
const PINNED_VERSION = '8.30.1';

const BIN = process.env.GITLEAKS_BIN || 'gitleaks';

function fail(lines) {
  for (const line of lines) console.error(line);
  process.exit(1);
}

// --- The config must exist -------------------------------------------------

if (!existsSync(join(ROOT, CONFIG))) {
  fail([
    `check-secrets: ${CONFIG} is missing.`,
    'Without it gitleaks would silently fall back to its own defaults, dropping this',
    "repo's allowlist and changing what counts as a finding. Refusing to scan.",
  ]);
}

// --- The pin must agree with what CI downloads -----------------------------

const ciWorkflow = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
const ciPin = ciWorkflow.match(/GITLEAKS_VERSION:\s*([0-9][0-9.]*)/)?.[1];
if (ciPin !== PINNED_VERSION) {
  fail([
    `check-secrets: version pin drift. This script expects gitleaks ${PINNED_VERSION};`,
    `.github/workflows/ci.yml downloads ${ciPin ?? '(no GITLEAKS_VERSION found)'}.`,
    'Different gitleaks versions ship different rules, so local and CI would disagree',
    'about what a secret is. Update both, and .pre-commit-config.yaml.',
  ]);
}

// --- The binary must be present --------------------------------------------

const version = spawnSync(BIN, ['version'], { encoding: 'utf8' });
if (version.error || version.status !== 0) {
  fail([
    'check-secrets: gitleaks is not installed, so the secret scan cannot run.',
    '',
    'This is a hard failure on purpose. A pushed secret is a rotation, not a revert,',
    'and a scan that skips itself when the tool is missing is a gate that cannot fail',
    '(#442). Install it — any of these:',
    '',
    `  brew install gitleaks            # then check: gitleaks version -> ${PINNED_VERSION}`,
    '  bash scripts/setup-dev.sh        # installs it alongside the rest of the setup',
    '  https://github.com/gitleaks/gitleaks#installing',
    '',
    'Or point this at an existing binary:  GITLEAKS_BIN=/path/to/gitleaks npm run verify',
  ]);
}

const localVersion = (version.stdout ?? '').trim();
if (localVersion !== PINNED_VERSION) {
  // Not a failure: a newer local gitleaks is not wrong, it just has a different
  // rule set, and hard-failing on it would turn every upstream release into a
  // blocked push. It IS worth saying out loud, because it is the reason a local
  // pass and a CI pass can differ.
  console.warn(
    `check-secrets: local gitleaks is ${localVersion}, CI runs ${PINNED_VERSION}. ` +
      'Different rule sets — a local pass does not fully guarantee the CI scan.'
  );
}

// --- Both modes, separately spawned, separately gated ----------------------

const MODES = [
  {
    id: 'history',
    args: ['detect', '--source', '.', '--config', CONFIG, '--redact', '--no-banner', '--verbose'],
    covers: 'every commit patch, including a secret that was committed and later removed',
  },
  {
    id: 'files',
    args: [
      'detect',
      '--source',
      '.',
      '--config',
      CONFIG,
      '--redact',
      '--no-banner',
      '--verbose',
      '--no-git',
      // Not `--follow-symlinks`: a symlink out of the tree is not this repo's
      // content, and following one would make the scan depend on whatever the
      // developer happens to have linked in.
    ],
    covers:
      'the files as they exist on disk — uncommitted edits, untracked files, ' +
      'merge-resolution content, and anything git diffs as binary',
  },
];

const results = [];
for (const mode of MODES) {
  const run = spawnSync(BIN, mode.args, { cwd: ROOT, encoding: 'utf8' });
  results.push({ mode, run });
}

// A dropped mode is indistinguishable from a passing one at the end, so it is
// checked explicitly rather than assumed — same discipline as run-gate.mjs.
if (results.length !== MODES.length) {
  fail([
    `check-secrets: ran ${results.length} of ${MODES.length} scan modes. That is a bug in`,
    'this script, and it must not be reported as a pass.',
  ]);
}

const failed = results.filter(({ run }) => run.error || run.status !== 0);

if (failed.length > 0) {
  console.error(
    'Secret scan FAILED. A pushed secret is a rotation, not a revert — fix this before\n' +
      'pushing, and rotate anything that was real.\n'
  );
  for (const { mode, run } of failed) {
    console.error(`--- gitleaks ${mode.id} mode (covers ${mode.covers}) ---`);
    if (run.error) console.error(`  could not run gitleaks: ${run.error.message}`);
    console.error(`${run.stdout ?? ''}${run.stderr ?? ''}`);
    console.error(`  reproduce: ${BIN} ${mode.args.join(' ')}\n`);
  }
  process.exit(1);
}

console.log(
  `No secrets found (gitleaks ${localVersion}, ${MODES.length} modes: ` +
    `${MODES.map((mode) => mode.id).join(' + ')}).`
);
