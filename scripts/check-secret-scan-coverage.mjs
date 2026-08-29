#!/usr/bin/env node
/**
 * Secret-scan coverage gate (SEC-17).
 *
 * gitleaks is the only secret gate this repo has, and it is configured by
 * `.gitleaks.toml`. Two properties of that file silently decide how much it
 * actually scans, and neither one is visible in a green build:
 *
 *   1. `[extend] useDefault = true`. gitleaks treats a config it finds as the
 *      WHOLE configuration. Without this line the upstream ruleset never
 *      loads, so the scanner runs with zero detectors and exits 0 on every
 *      input, reporting success while checking nothing.
 *
 *   2. `[allowlist] paths`. gitleaks has ONE allowlist, not one per scan
 *      mode, so every path pattern applies to `detect --source .` (git
 *      history) exactly as much as to `detect --no-git` (working tree). A
 *      pattern intended to quieten gitignored build output will, if it also
 *      matches a tracked file, delete that file from both scans at once.
 *
 * This gate enforces (1) directly, and enforces (2) as the invariant that a
 * path exclusion may match only paths that are gitignored and therefore never
 * tracked. `main` excludes zero tracked files, so "zero tracked files
 * excluded" is exactly the statement that coverage never drops below what
 * `main` covers, and unlike a hard-coded file count it does not false-fire
 * when the tree legitimately grows or shrinks.
 *
 * Why it exists: an earlier revision of PR #361 added
 * `(^|/)frontend/(android|ios)/` to the allowlist. That matched 76 tracked
 * files, among them `frontend/android/gradle.properties` and
 * `frontend/ios/debug.xcconfig`, which is where signing credentials and
 * mobile API keys live. Measured with gitleaks 8.30.1: a synthetic GitHub PAT
 * committed to `frontend/android/gradle.properties` was caught by `main`'s
 * config (exit 1) and reported "no leaks found" (exit 0) with that revision,
 * in both scan modes. Nothing in `npm run verify` or CI noticed.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const CONFIG = '.gitleaks.toml';

const raw = readFileSync(CONFIG, 'utf8');

// Drop whole-line comments so a pattern parked in a comment is not read as
// live configuration. The patterns themselves never contain '#'.
const live = raw
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

const failures = [];

// ---- (1) the default ruleset must actually load ----------------------------
if (!/\[extend\][\s\S]*?useDefault\s*=\s*true/.test(live)) {
  failures.push(
    `${CONFIG} does not set \`useDefault = true\` under \`[extend]\`.\n` +
      '  gitleaks treats a config it finds as the whole configuration, so the\n' +
      '  upstream ruleset would never load and the scan would exit 0 with zero\n' +
      '  detectors, reporting success while checking nothing.'
  );
}

// ---- (2) no path exclusion may match a tracked file ------------------------
// Collect every `paths = [ ... ]` array, covering both `[allowlist]` and any
// `[[allowlists]]` blocks, and every string literal inside them. TOML spells a
// string four ways and gitleaks accepts all of them, so all four are read here
// rather than only the '''literal''' form this config happens to use.
//
// Then check the residue. A gate that quietly skips a pattern it cannot parse
// is the same class of failure it exists to prevent, and counting parsed
// literals is not enough to notice: one unreadable element sitting among eight
// readable ones still yields eight. So every literal is blanked out of the
// array body and what is left must be nothing but commas and whitespace.
// Anything else means an element went unchecked, and that fails the build.
const LITERAL = /'''([\s\S]*?)'''|"""([\s\S]*?)"""|'([^']*)'|"((?:[^"\\]|\\.)*)"/g;
const patterns = [];
for (const block of live.matchAll(/^\s*paths\s*=\s*\[([\s\S]*?)\]/gm)) {
  const body = block[1];
  let residue = body;
  for (const literal of body.matchAll(LITERAL)) {
    patterns.push(literal[1] ?? literal[2] ?? literal[3] ?? literal[4]);
    residue = residue.replace(literal[0], '');
  }
  const leftover = residue.replace(/[,\s]/g, '');
  if (leftover !== '') {
    failures.push(
      `${CONFIG}: a \`paths = [...]\` array holds an element this gate could not parse, so\n` +
        '  that element was never checked against the tracked file list. Write every entry\n' +
        `  as a TOML string literal, or teach this script the spelling used.\n` +
        `  Unparsed: ${leftover}`
    );
  }
}

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

// The patterns are Go RE2 source. Every construct used here (alternation,
// anchors, escaped dots, character classes) has identical meaning in JS, and
// an unsupported one throws below rather than being silently skipped.
const excluded = new Map();
for (const pattern of patterns) {
  let re;
  try {
    re = new RegExp(pattern);
  } catch (err) {
    failures.push(
      `${CONFIG}: allowlist path pattern ${pattern} is not a usable regex: ${err.message}`
    );
    continue;
  }
  const hits = tracked.filter((file) => re.test(file));
  if (hits.length > 0) excluded.set(pattern, hits);
}

if (excluded.size > 0) {
  const total = new Set([...excluded.values()].flat()).size;
  const detail = [...excluded.entries()]
    .map(([pattern, hits]) => {
      const shown = hits.slice(0, 5).map((f) => `      ${f}`);
      if (hits.length > shown.length) shown.push(`      ...and ${hits.length - shown.length} more`);
      return `  ${pattern}  matches ${hits.length} tracked file(s):\n${shown.join('\n')}`;
    })
    .join('\n');
  failures.push(
    `${CONFIG} allowlist \`paths\` removes ${total} TRACKED file(s) from the secret scan.\n` +
      '  gitleaks applies one allowlist to BOTH scan modes, so these files are\n' +
      '  scanned by neither `detect --source .` nor `detect --no-git`. A path\n' +
      '  exclusion may match only gitignored output, never a tracked file.\n' +
      `${detail}`
  );
}

if (failures.length > 0) {
  console.error('Secret-scan coverage gate failed.\n');
  for (const failure of failures) console.error(`${failure}\n`);
  process.exit(1);
}

console.log(
  `Secret-scan coverage: ${tracked.length}/${tracked.length} tracked files in scope ` +
    `(${patterns.length} path exclusion(s), all gitignored-only), default ruleset loaded.`
);
