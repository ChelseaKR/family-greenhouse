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
 * jobs run `test:coverage`, and `.husky/pre-push` runs `npm run verify` which
 * chains the same command. A contributor reading that section would have
 * concluded a coverage drop couldn't block their merge, and been wrong.
 *
 * Hand-maintained numbers rot. So the numbers that CAN be derived cheaply are
 * derived here and diffed against the doc:
 *
 *   1. Test FILE counts per layer, from the filesystem.
 *   2. Coverage thresholds, from the two vitest configs.
 *   3. The enforcement claims themselves — that thresholds exist in both
 *      configs, that the two CI test jobs run `test:coverage`, that pre-push
 *      runs `npm run verify`, and that the retired "not enforced" phrasings
 *      have not come back.
 *
 * Test CASE counts are deliberately NOT checked: collecting them means running
 * both suites, which is far too slow for a lint-stage gate. The doc labels them
 * as a dated snapshot and says how to reproduce them.
 *
 * Runs in CI's Lint job and in `npm run verify` — the same both-places pattern
 * as check-no-bare-markers.mjs (see CICD-27, make-verify parity).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
// 1. Test file counts per layer
// ---------------------------------------------------------------------------

const layers = [
  ['backend/tests/unit/', countFiles('backend/tests/unit', VITEST)],
  ['backend/tests/integration/', countFiles('backend/tests/integration', VITEST)],
  ['backend/tests/eval/', countFiles('backend/tests/eval', VITEST)],
  ['frontend/tests/unit/', countFiles('frontend/tests/unit', VITEST)],
  ['frontend/src/**/*.test.ts', countFiles('frontend/src', VITEST)],
  ['frontend/tests/integration/', countFiles('frontend/tests/integration', VITEST)],
  ['frontend/tests/e2e/', countFiles('frontend/tests/e2e', PLAYWRIGHT)],
];

/**
 * Pull the `Files` cell out of the counts table row whose `Where` cell
 * contains the given path. Rows look like:
 *   | Backend unit | vitest | `backend/tests/unit/{...}` | 90 | 1,270 |
 */
function docFileCount(where) {
  const table = doc.match(/<!-- BEGIN:TEST-COUNTS[\s\S]*?<!-- END:TEST-COUNTS -->/);
  if (!table) return null;
  for (const line of table[0].split('\n')) {
    if (!line.trim().startsWith('|') || !line.includes(where)) continue;
    const cells = line.split('|').map((c) => c.trim());
    // ['', Layer, Tool, Where, Files, Test cases, '']
    const files = Number(cells[4]);
    return Number.isNaN(files) ? null : files;
  }
  return null;
}

for (const [where, actual] of layers) {
  const stated = docFileCount(where);
  if (stated === null) {
    errors.push(
      `${DOC_PATH}: counts table has no row for \`${where}\` (or its Files cell is not a number).`
    );
  } else if (stated !== actual) {
    errors.push(
      `${DOC_PATH}: counts table says ${stated} file(s) for \`${where}\`, but the repo has ${actual}. Update the table.`
    );
  }
}

const totalVitestFiles = layers
  .filter(([where]) => where !== 'frontend/tests/e2e/')
  .reduce((n, [, c]) => n + c, 0);
if (!doc.includes(`${totalVitestFiles} files`)) {
  errors.push(
    `${DOC_PATH}: should state "${totalVitestFiles} files" as the vitest file total (sum of every non-e2e row).`
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

if (!read('.husky/pre-push').includes('npm run verify')) {
  errors.push(`.husky/pre-push no longer runs \`npm run verify\`, but ${DOC_PATH} says it does.`);
}

const verify = JSON.parse(read('package.json')).scripts.verify ?? '';
if (!verify.includes('test:coverage')) {
  errors.push(
    `package.json: \`verify\` no longer chains \`test:coverage\`, but ${DOC_PATH} says it does.`
  );
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
  `docs/testing.md matches the repo (${totalVitestFiles} vitest files, coverage floors in sync).`
);
