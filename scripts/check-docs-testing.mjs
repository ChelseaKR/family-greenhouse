#!/usr/bin/env node
/**
 * Keeps `docs/testing.md` honest about the suite it documents.
 *
 * Why this exists: the doc drifted until it was wrong by roughly 7x (it
 * advertised "~300+ test cases" against an actual 2,176, described the backend
 * integration layer as one file when there were eight, and — the part that
 * actually mattered — stated that coverage was "configured but not enforced"
 * and that "we don't gate CI on coverage %". Both claims were false: floors
 * sit in BOTH vitest configs, the required `Test Backend` / `Test Frontend` CI
 * jobs run `test:coverage`, and `.githooks/pre-push` runs `npm run verify` which
 * chains the same command. A contributor reading that section would have
 * concluded a coverage drop couldn't block their merge, and been wrong.
 *
 * Hand-maintained numbers rot. So what CAN be derived cheaply is derived here
 * and diffed against the doc:
 *
 *   1. The test layers themselves — every layer this script counts has a row
 *      in the doc's table naming the path it actually lives at.
 *   2. Coverage thresholds, from the two vitest configs.
 *   3. The enforcement claims themselves — that thresholds exist in both
 *      configs, that the two CI test jobs run `test:coverage`, that pre-push
 *      runs `npm run verify`, and that the retired "not enforced" phrasings
 *      have not come back.
 *
 * Test FILE counts are derived, not documented. They used to be written into
 * the table and checked here, which kept them honest but made every PR that
 * added a test file rewrite the same two lines — on 2026-09-03 nine open PRs
 * were unmergeable on `docs/testing.md` alone, and the correct post-merge
 * number was on none of them. `--print` shows the live per-layer counts; the
 * check refuses a `Files` column or an "across N files" total so the conflict
 * surface cannot come back.
 *
 * Test CASE counts are deliberately NOT checked: collecting them means running
 * both suites, which is far too slow for a lint-stage gate. The doc labels them
 * as a dated snapshot and says how to reproduce them.
 *
 * Runs in CI's Lint job and in `npm run verify` — the same both-places pattern
 * as check-no-bare-markers.mjs (see CICD-27, make-verify parity).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STEPS as GATE_STEPS } from './gate-steps.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOC_PATH = 'docs/testing.md';
const doc = readFileSync(join(ROOT, DOC_PATH), 'utf8');
const errors = [];

const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/** Every file under `dir` (recursively) whose name matches `re`. */
function countFiles(dir, re) {
  let n = 0;
  const walk = (d) => {
    for (const entry of readdirSync(join(ROOT, d))) {
      const rel = join(d, entry);
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
      else if (re.test(entry)) n += 1;
    }
  };
  walk(dir);
  return n;
}

const VITEST = /\.test\.tsx?$/;
const PLAYWRIGHT = /\.spec\.ts$/;

// ---------------------------------------------------------------------------
// 1. Test layers: each one the script counts has a row, at its real path
// ---------------------------------------------------------------------------

// [doc row's `Where` text, directory walked, file pattern]. The `Where` text is
// what the doc row must contain; the directory is what actually gets counted.
const LAYERS = [
  ['backend/tests/unit/', 'backend/tests/unit', VITEST],
  ['backend/tests/integration/', 'backend/tests/integration', VITEST],
  ['backend/tests/eval/', 'backend/tests/eval', VITEST],
  ['frontend/tests/unit/', 'frontend/tests/unit', VITEST],
  ['frontend/src/**/*.test.ts', 'frontend/src', VITEST],
  ['frontend/tests/integration/', 'frontend/tests/integration', VITEST],
  ['frontend/tests/e2e/', 'frontend/tests/e2e', PLAYWRIGHT],
];

// A layer whose directory is gone is the "integration layer was really eight
// files" drift in reverse: the doc would keep a row for tests that no longer
// live there. Fail with the fix spelled out rather than an ENOENT stack.
const layers = [];
for (const [where, dir, re] of LAYERS) {
  if (!existsSync(join(ROOT, dir))) {
    errors.push(
      `${dir}/ no longer exists, but this script and ${DOC_PATH} both list it as a test layer. Move or drop the entry in both.`
    );
    continue;
  }
  layers.push([where, countFiles(dir, re)]);
}

const totalVitestFiles = layers
  .filter(([where]) => where !== 'frontend/tests/e2e/')
  .reduce((n, [, c]) => n + c, 0);

if (process.argv.includes('--print')) {
  const width = Math.max(...layers.map(([where]) => where.length));
  for (const [where, n] of layers) console.log(`${where.padEnd(width)}  ${n}`);
  console.log(`${'vitest total (non-e2e)'.padEnd(width)}  ${totalVitestFiles}`);
  process.exit(errors.length > 0 ? 1 : 0);
}

const table = doc.match(/<!-- BEGIN:TEST-COUNTS[\s\S]*?<!-- END:TEST-COUNTS -->/);
if (!table) {
  errors.push(`${DOC_PATH}: the TEST-COUNTS marked block is missing.`);
} else {
  const rows = table[0].split('\n').filter((l) => l.trim().startsWith('|'));
  for (const [where] of layers) {
    if (!rows.some((l) => l.includes(where))) {
      errors.push(`${DOC_PATH}: counts table has no row for \`${where}\`.`);
    }
  }
  // The retired column. A `Files` cell is a hand-maintained number that every
  // test-adding PR must rewrite; see the header comment for what that cost.
  const header = rows[0] ?? '';
  if (/\|\s*Files\s*\|/.test(header)) {
    errors.push(
      `${DOC_PATH}: counts table has a \`Files\` column again. File counts are derived (\`--print\`), not documented — drop the column.`
    );
  }
}

// The retired total. Same reasoning as the column.
const total = doc.match(/across \d[\d,]* files/);
if (total) {
  errors.push(
    `${DOC_PATH}: says "${total[0]}" — a hand-maintained file total. File counts are derived (\`--print\`), not documented — drop the figure.`
  );
}

// ---------------------------------------------------------------------------
// 2. Coverage thresholds, read out of the vitest configs
// ---------------------------------------------------------------------------

/** Parse the `thresholds: { lines: N, ... }` block out of a vitest config. */
function thresholdsOf(configPath) {
  const src = read(configPath);
  const block = src.match(/thresholds:\s*\{([^}]*)\}/);
  if (!block) return null;
  const pick = (k) => {
    const m = block[1].match(new RegExp(`${k}:\\s*(\\d+)`));
    return m ? Number(m[1]) : null;
  };
  return {
    lines: pick('lines'),
    statements: pick('statements'),
    branches: pick('branches'),
    functions: pick('functions'),
  };
}

const configs = [
  ['Backend', 'backend/vitest.config.ts'],
  ['Frontend', 'frontend/vitest.config.ts'],
];

const thresholdTable = doc.match(
  /<!-- BEGIN:COVERAGE-THRESHOLDS[\s\S]*?<!-- END:COVERAGE-THRESHOLDS -->/
);
if (!thresholdTable) {
  errors.push(`${DOC_PATH}: the COVERAGE-THRESHOLDS marked block is missing.`);
}

for (const [label, configPath] of configs) {
  const actual = thresholdsOf(configPath);
  if (!actual || Object.values(actual).some((v) => v === null)) {
    // This is the enforcement claim itself: the doc says floors exist in BOTH
    // configs. If one loses its thresholds block, the doc has become false.
    errors.push(
      `${configPath}: no complete coverage \`thresholds\` block found, but ${DOC_PATH} states coverage is enforced in both workspaces.`
    );
    continue;
  }
  if (!thresholdTable) continue;
  const row = thresholdTable[0]
    .split('\n')
    .find((l) => l.trim().startsWith('|') && l.includes(label));
  if (!row) {
    errors.push(`${DOC_PATH}: coverage table has no \`${label}\` row.`);
    continue;
  }
  const cells = row.split('|').map((c) => c.trim());
  const stated = {
    lines: Number(cells[2]),
    statements: Number(cells[3]),
    branches: Number(cells[4]),
    functions: Number(cells[5]),
  };
  for (const metric of ['lines', 'statements', 'branches', 'functions']) {
    if (stated[metric] !== actual[metric]) {
      errors.push(
        `${DOC_PATH}: coverage table says ${label} ${metric} floor is ${stated[metric]}, but ${configPath} sets ${actual[metric]}.`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 3. The enforcement claims
// ---------------------------------------------------------------------------

const ciLines = read('.github/workflows/ci.yml').split('\n');
/** The body of the job whose `name:` is `label`, up to the next job key. */
function ciJobBody(label) {
  const at = ciLines.findIndex((l) => l.trim() === `name: ${label}`);
  if (at === -1) return null;
  // Walk back to this job's key (`  someJob:` at two-space indent) …
  let start = at;
  while (start > 0 && !/^ {2}[\w-]+:\s*$/.test(ciLines[start])) start -= 1;
  // … and forward to the next one.
  let end = start + 1;
  while (end < ciLines.length && !/^ {2}[\w-]+:\s*$/.test(ciLines[end])) end += 1;
  return ciLines.slice(start, end).join('\n');
}

for (const job of ['Test Frontend', 'Test Backend']) {
  const body = ciJobBody(job);
  if (body === null) {
    errors.push(
      `.github/workflows/ci.yml: no \`${job}\` job, but ${DOC_PATH} names it as a required coverage gate.`
    );
  } else if (!body.includes('test:coverage')) {
    errors.push(
      `.github/workflows/ci.yml: the \`${job}\` job no longer runs \`test:coverage\`, but ${DOC_PATH} says it does.`
    );
  }
}

// The hook moved from `.husky/pre-push` (reached through husky's generated,
// git-ignored `.husky/_` shim) to the tracked `.githooks/pre-push` — see #544
// and scripts/check-git-hooks.mjs. `read()` throws on a missing file, so a
// rename cannot turn this assertion into a vacuous pass.
if (!read('.githooks/pre-push').includes('npm run verify')) {
  errors.push(
    `.githooks/pre-push no longer runs \`npm run verify\`, but ${DOC_PATH} says it does.`
  );
}

// `verify` used to be a literal `&&` chain and this was a substring match on
// it. It now delegates to scripts/run-gate.mjs, so the same claim — pre-push
// enforces BOTH workspaces' coverage floors — is checked against the gate's
// own step list, per workspace. That is stricter than the substring ever was:
// the old form was satisfied by a single `--workspaces` invocation whose
// `--if-present` would have quietly skipped a workspace that lost the script.
const rootPkg = JSON.parse(read('package.json'));
const verify = rootPkg.scripts.verify ?? '';
if (!verify.includes('run-gate.mjs')) {
  errors.push(
    `package.json: \`verify\` no longer runs scripts/run-gate.mjs, so the gate steps below cannot be checked. If the gate moved, update this script too.`
  );
} else {
  for (const ws of rootPkg.workspaces ?? []) {
    if (!GATE_STEPS.some((s) => s.workspace === ws && s.script === 'test:coverage')) {
      errors.push(
        `scripts/gate-steps.mjs: no \`test:coverage\` step for the \`${ws}\` workspace, but ${DOC_PATH} says pre-push enforces every workspace's coverage floors.`
      );
    }
  }
}

// The exact retired claims. These were live and false; keep them retired.
const RETIRED = [
  'configured but not enforced',
  "don't gate CI on coverage",
  'do not gate CI on coverage',
];
for (const phrase of RETIRED) {
  if (doc.toLowerCase().includes(phrase.toLowerCase())) {
    errors.push(
      `${DOC_PATH}: contains the retired (and false) claim "${phrase}". Coverage floors ARE enforced — in both vitest configs, in the required CI test jobs, and in pre-push.`
    );
  }
}

// ---------------------------------------------------------------------------

if (errors.length > 0) {
  console.error('docs/testing.md is out of sync with the repo:\n');
  for (const e of errors) console.error(`  - ${e}`);
  console.error('');
  process.exit(1);
}

console.log(
  `docs/testing.md matches the repo (${layers.length} test layers, ${totalVitestFiles} vitest files on disk, coverage floors in sync).`
);
