#!/usr/bin/env node
/**
 * Repo-wide regression gate (P0-3): forbid new `continue-on-error: true` or a
 * `|| true`-silenced test/security/lint command in any GitHub Actions
 * workflow. This is the guard against reintroducing the exact bypasses this
 * remediation pass closed (cd-staging.yml's `continue-on-error: true` on the
 * E2E step; the `skip-lighthouse` label — see ci.yml's lighthouse job).
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
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const WORKFLOWS_DIR = '.github/workflows';
const CONTINUE_ON_ERROR = /continue-on-error:\s*true/;
const SILENCE_TOKENS =
  /\b(test|audit|gitleaks|semgrep|lint|eslint|tsc|playwright|pytest|codeql|zizmor|trivy|grype|typecheck)\b/i;
const OR_TRUE = /\|\|\s*true\b/;
const ALLOW_ANNOTATION = /#\s*allow-silenced-gate:\s*\S/;

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

const files = readdirSync(WORKFLOWS_DIR)
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .map((f) => join(WORKFLOWS_DIR, f));

const allOffenders = files.flatMap(findOffenders);

if (allOffenders.length > 0) {
  console.error(
    'Silenced test/security/lint gate found in a workflow. `continue-on-error: true` and\n' +
      '`|| true` on a test/lint/security/scan command make that gate decorative — either\n' +
      'remove it, or annotate the line above with `# allow-silenced-gate: <reason>` if it is\n' +
      'a deliberate, reviewed exception:\n'
  );
  for (const o of allOffenders) console.error(`  ${o.file}:${o.lineNo}: ${o.line}`);
  process.exit(1);
}

console.log('No silenced test/security/lint gates found in .github/workflows/.');
