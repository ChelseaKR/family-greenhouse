#!/usr/bin/env node
/**
 * No-hardcoded-strings gate (G2, STANDARDS/INTERNATIONALIZATION-STANDARD.md §4)
 * — a RATCHET, not a hard zero. Run by `npm run i18n:check` and CI's `i18n`
 * job. Conventions in docs/i18n.md.
 *
 * Scans every JSX *text node* in frontend/src for natural-language English
 * that bypasses the i18n catalog (i.e. is not rendered through `t()` /
 * <Trans>). The pre-existing debt is pinned per file in
 * `scripts/i18n-hardcoded-baseline.json`; the gate fails when
 *
 *   - a file gains hardcoded strings over its baseline count, or
 *   - a file not in the baseline introduces any.
 *
 * When you migrate strings out of a file, lower (or delete) its baseline
 * entry in the same PR — the gate prints the exact entries to update. The
 * baseline may only ever shrink.
 *
 * Pragmatic allowlist (documented in docs/i18n.md):
 *   - text nodes with no run of 2+ letters (numbers, punctuation, `·`, `—`);
 *   - brand/proper-noun and technical exact strings in ALLOWED_EXACT;
 *   - curated long-form English content that is deliberately a separate
 *     translation workstream from UI chrome (blog posts, help FAQ, legal,
 *     care guides, changelog) — EXCLUDED_DIRS below;
 *   - attributes are out of scope for this scanner: aria-*, alt, title etc.
 *     are covered by eslint-plugin-i18next's `ignoreAttribute` config as files
 *     are enrolled in the stricter per-file lint (see eslint.config.mjs).
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const FRONTEND_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(FRONTEND_DIR, 'src');
const BASELINE_PATH = path.join(FRONTEND_DIR, 'scripts', 'i18n-hardcoded-baseline.json');
const UPDATE = process.argv.includes('--update-baseline');

/** Curated-content surfaces: translating these is a separate workstream. */
const EXCLUDED_DIRS = [
  'features/blog',
  'features/help',
  'features/legal',
  'features/care',
  'features/changelog',
];

/** Brand names / technical tokens that are correct in every locale. */
const ALLOWED_EXACT = new Set(['Family Greenhouse', 'CSV', 'JSON', 'API', 'PWA', 'SMS', 'OK']);

const NATURAL_LANGUAGE = /\p{L}{2,}/u;

function* tsxFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* tsxFiles(abs);
    else if (entry.name.endsWith('.tsx')) yield abs;
  }
}

function isExcluded(rel) {
  return EXCLUDED_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`));
}

/** rel file -> [{ line, text }] */
const found = new Map();
let scanned = 0;

for (const abs of tsxFiles(SRC)) {
  const rel = path.relative(SRC, abs);
  if (isExcluded(rel)) continue;
  scanned += 1;
  const source = ts.createSourceFile(
    abs,
    readFileSync(abs, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const hits = [];
  const visit = (node) => {
    if (ts.isJsxText(node)) {
      const text = node.text.replace(/\s+/g, ' ').trim();
      if (text && NATURAL_LANGUAGE.test(text) && !ALLOWED_EXACT.has(text)) {
        hits.push({
          line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          text: text.length > 60 ? `${text.slice(0, 57)}…` : text,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (hits.length > 0) found.set(rel, hits);
}

const actual = Object.fromEntries([...found.entries()].sort().map(([f, h]) => [f, h.length]));

if (UPDATE) {
  writeFileSync(
    BASELINE_PATH,
    JSON.stringify(
      {
        $comment:
          'Per-file count of hardcoded JSX text nodes (i18n debt ratchet — see scripts/check-hardcoded-strings.mjs and docs/i18n.md). Counts may only decrease; regenerate with `node scripts/check-hardcoded-strings.mjs --update-baseline` ONLY after reducing debt, never to admit new hardcoded strings.',
        files: actual,
      },
      null,
      2
    ) + '\n'
  );
  console.log(
    `Baseline updated: ${Object.keys(actual).length} files, ${Object.values(actual).reduce((a, b) => a + b, 0)} strings.`
  );
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).files;
const problems = [];
const improvements = [];

for (const [file, count] of Object.entries(actual)) {
  const allowed = baseline[file] ?? 0;
  if (count > allowed) {
    const preview = found
      .get(file)
      .slice(0, 5)
      .map((h) => `      L${h.line}: "${h.text}"`)
      .join('\n');
    problems.push(
      `${file}: ${count} hardcoded JSX strings (baseline ${allowed}) — move new strings into ` +
        `src/i18n/locales/*/translation.json and render via t(). First hits:\n${preview}`
    );
  } else if (count < allowed) {
    improvements.push(`${file}: ${count} < baseline ${allowed}`);
  }
}
for (const file of Object.keys(baseline)) {
  if (!(file in actual))
    improvements.push(`${file}: 0 < baseline ${baseline[file]} (or file removed)`);
}

const total = Object.values(actual).reduce((a, b) => a + b, 0);
const baselineTotal = Object.values(baseline).reduce((a, b) => a + b, 0);

if (problems.length > 0) {
  console.error(
    `Hardcoded-string gate FAILED (${problems.length} file${problems.length === 1 ? '' : 's'} over baseline):\n`
  );
  for (const p of problems) console.error(`  - ${p}\n`);
  process.exit(1);
}

if (improvements.length > 0) {
  console.error(
    `Hardcoded-string debt went DOWN (thank you) — ratchet the baseline in the same PR so it can't creep back:\n` +
      improvements.map((i) => `  - ${i}`).join('\n') +
      `\n\nRun: node scripts/check-hardcoded-strings.mjs --update-baseline`
  );
  process.exit(1);
}

console.log(
  `Hardcoded-string gate passed: ${scanned} components scanned, ${total} known hardcoded JSX strings ` +
    `(baseline ${baselineTotal}, ratchet-only).`
);
