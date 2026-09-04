#!/usr/bin/env node
/**
 * Repo-wide regression gate (P0-3): forbid new `continue-on-error: true` or a
 * `|| true`-silenced test/security/lint command in any GitHub Actions
 * workflow, AND a spec that switches itself off when it detects CI. This is
 * the guard against reintroducing the exact bypasses this remediation pass
 * closed (cd-staging.yml's `continue-on-error: true` on the E2E step; the
 * `skip-lighthouse` label — see ci.yml's lighthouse job).
 *
 * ## Why spec files are scanned too
 *
 * `test.skip(Boolean(process.env.CI), ...)` inside a spec is the same idea as
 * `continue-on-error: true`, expressed one directory over where this script
 * did not look. `visual-regression.spec.ts` does exactly that, and it lives in
 * `E2E + accessibility (Playwright)` — a REQUIRED status check
 * (.github/rulesets/main.json). So a required check contained a suite that
 * never executed, while docs/testing.md listed it as live coverage. The suite
 * in question covers the CloudFront SPA router, which took production down.
 *
 * The existing skip is legitimate and documented (its snapshots are
 * `*-darwin.png` and CI runs Linux, so they cannot be compared), so it is
 * annotated rather than removed. What this catches is the NEXT one, added
 * without that scrutiny.
 *
 * Deliberately narrow on the `|| true` rule: shell idioms like
 * `[ -f x ] && cp x y || true` (an optional-file no-op, used in
 * cd-staging.yml/cd-production.yml's Lambda packaging step) are legitimate
 * and NOT test/security silencing — only lines that also reference a
 * test/lint/security/scan-ish command are flagged, so this doesn't misfire
 * on ordinary shell conditionals.
 *
 * Escape hatch: a line immediately preceded by
 * `# allow-silenced-gate: <reason>` is allowed — matches the CQ-35
 * "no un-annotated lint suppressions" convention (annotate, don't just add).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const WORKFLOWS_DIR = '.github/workflows';
const SPECS_DIR = 'frontend/tests/e2e';
// `test.skip(Boolean(process.env.CI))`, `test.skip(!!process.env.CI)` and the
// bare `test.skip(process.env.CI ...)` form, `describe`/`it` included.
// Deliberately whitespace-tolerant and scanned over the whole file rather than
// line by line: prettier wraps the call across three lines, which is exactly
// how the one existing instance is written, so a per-line regex would miss the
// real case and only catch a hypothetical tidy one.
const CI_SELF_SKIP = /\b(?:test|describe|it)\.skip\(\s*(?:Boolean\(\s*|!!\s*)?process\.env\.CI/g;
const CONTINUE_ON_ERROR = /continue-on-error:\s*true/;
const SILENCE_TOKENS =
  /\b(test|audit|gitleaks|semgrep|lint|eslint|tsc|playwright|pytest|codeql|zizmor|trivy|grype|typecheck)\b/i;
const OR_TRUE = /\|\|\s*true\b/;
// `#` in YAML, `//` in TypeScript.
const ALLOW_ANNOTATION = /(?:#|\/\/)\s*allow-silenced-gate:\s*\S/;

function findOffenders(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const offenders = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue; // comment/prose, not live YAML/shell
    const prevAnnotated = i > 0 && ALLOW_ANNOTATION.test(lines[i - 1]);
    if (prevAnnotated) continue;

    if (CONTINUE_ON_ERROR.test(line)) {
      offenders.push({ file, lineNo: i + 1, line: line.trim() });
      continue;
    }
    if (OR_TRUE.test(line) && SILENCE_TOKENS.test(line)) {
      offenders.push({ file, lineNo: i + 1, line: line.trim() });
    }
  }
  return offenders;
}

/**
 * A spec that turns itself off in CI. Same annotation escape hatch as above,
 * on the line before — annotate, don't just add.
 */
function findCiSelfSkips(file) {
  const source = readFileSync(file, 'utf8');
  const lines = source.split('\n');
  const offenders = [];
  CI_SELF_SKIP.lastIndex = 0;
  for (const match of source.matchAll(CI_SELF_SKIP)) {
    const lineNo = source.slice(0, match.index).split('\n').length;
    const line = lines[lineNo - 1] ?? '';
    // Prose about the rule, not the rule.
    if (line.trim().startsWith('*') || line.trim().startsWith('//')) continue;
    // The annotation sits somewhere in the comment block immediately above the
    // call. Unlike the YAML branch — where one `#` line above is the whole
    // convention — a spec's justification is usually a paragraph, and
    // demanding the annotation be its LAST line would be a formatting rule
    // dressed up as a safety rule. So walk back over contiguous `//` lines and
    // blanks, and accept the annotation anywhere in that block.
    let above = lineNo - 2;
    let annotated = false;
    while (above >= 0) {
      const text = lines[above].trim();
      if (text === '') {
        above -= 1;
        continue;
      }
      if (!text.startsWith('//')) break;
      if (ALLOW_ANNOTATION.test(text)) {
        annotated = true;
        break;
      }
      above -= 1;
    }
    if (annotated) continue;
    offenders.push({ file, lineNo, line: line.trim() });
  }
  return offenders;
}

const files = readdirSync(WORKFLOWS_DIR)
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .map((f) => join(WORKFLOWS_DIR, f));

const specs = existsSync(SPECS_DIR)
  ? readdirSync(SPECS_DIR)
      .filter((f) => f.endsWith('.spec.ts'))
      .map((f) => join(SPECS_DIR, f))
  : [];

const allOffenders = [...files.flatMap(findOffenders), ...specs.flatMap(findCiSelfSkips)];

if (allOffenders.length > 0) {
  console.error(
    'Silenced test/security/lint gate found. `continue-on-error: true` and `|| true` on a\n' +
      'test/lint/security/scan command make that gate decorative, and a spec that calls\n' +
      '`test.skip(Boolean(process.env.CI))` makes a REQUIRED check contain a suite that never\n' +
      'runs — either remove it, or annotate the line above with `allow-silenced-gate: <reason>`\n' +
      '(`#` in YAML, `//` in TypeScript) if it is a deliberate, reviewed exception:\n'
  );
  for (const o of allOffenders) console.error(`  ${o.file}:${o.lineNo}: ${o.line}`);
  process.exit(1);
}

console.log(
  `No silenced test/security/lint gates found in ${WORKFLOWS_DIR}/ (${files.length} workflows) ` +
    `or ${SPECS_DIR}/ (${specs.length} specs).`
);
