#!/usr/bin/env node
/**
 * No-hardcoded-strings gate (G2, STANDARDS/INTERNATIONALIZATION-STANDARD.md §4)
 * — a RATCHET, not a hard zero. Run by `npm run i18n:check` and CI's `i18n`
 * job. Conventions in docs/i18n.md.
 *
 * TWO ratchets, both pinned per file in `scripts/i18n-hardcoded-baseline.json`
 * and both fail when a file goes over its baseline (or a file not in the
 * baseline introduces any):
 *
 *   1. `files`      — natural-language English in JSX *text nodes*.
 *   2. `attributes` — natural-language English in the JSX *attributes* a
 *                     screen reader or a placeholder actually speaks:
 *                     LINGUISTIC_ATTRIBUTES below.
 *
 * When you migrate strings out of a file, lower (or delete) its baseline
 * entry in the same PR — the gate prints the exact entries to update. The
 * baseline may only ever shrink.
 *
 * ## Why the attribute ratchet is here and not in ESLint
 *
 * It used to be nowhere. This script's header said attributes were covered by
 * `eslint-plugin-i18next`'s `ignoreAttribute` config, and `docs/i18n.md` said
 * the same. Both were wrong, in the same two ways: the rule runs with
 * `markupOnly: true`, which restricts it to JSX text nodes — the identical
 * scope as this scanner — and `ignoreAttribute` is an EXCLUSION list, with
 * `aria-label` and `placeholder` on it. It was also enrolled for five files
 * out of ~170. So each of the two gates documented the other as the owner of
 * attribute coverage and neither provided it, while ~50 English literals sat
 * outside every gate. For a Spanish-speaking screen-reader user `aria-label`
 * is the only string that matters, and it was the one nothing checked.
 *
 * ESLint has no ratchet, so enrolling the rule repo-wide would hard-fail on
 * the existing debt; this script already has the ratchet, so the check lives
 * here alongside the one it was always confused with.
 *
 * Pragmatic allowlist (documented in docs/i18n.md):
 *   - text and attribute values with no run of 2+ letters (numbers,
 *     punctuation, `·`, `—`);
 *   - brand/proper-noun and technical exact strings in ALLOWED_EXACT;
 *   - curated long-form English content that is deliberately a separate
 *     translation workstream from UI chrome (blog posts, help FAQ,
 *     care guides, changelog) — EXCLUDED_DIRS below;
 *   - non-linguistic attributes (`role`, `id`, `type`, `href`, `to`,
 *     `data-testid`, `autoComplete`, `inputMode`, `pattern`, …): everything
 *     not named in LINGUISTIC_ATTRIBUTES.
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
const EXCLUDED_DIRS = ['features/blog', 'features/help', 'features/care', 'features/changelog'];

/** Brand names / technical tokens that are correct in every locale. */
const ALLOWED_EXACT = new Set(['Family Greenhouse', 'CSV', 'JSON', 'API', 'PWA', 'SMS', 'OK']);

const NATURAL_LANGUAGE = /\p{L}{2,}/u;

/**
 * Attributes whose value is read aloud or shown to a user, so an English
 * literal in one is untranslated UI. Everything else — `role`, `id`, `type`,
 * `href`, `to`, `data-testid`, `autoComplete`, `inputMode`, `pattern` — is
 * machine-facing and deliberately out of scope.
 */
const LINGUISTIC_ATTRIBUTES = new Set([
  'alt',
  'aria-description',
  'aria-label',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
  'label',
  'placeholder',
  'title',
]);

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
/** rel file -> [{ line, text }] for linguistic attributes */
const foundAttrs = new Map();
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
  const attrHits = [];
  const at = (node) => source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const record = (list, node, text) => {
    if (text && NATURAL_LANGUAGE.test(text) && !ALLOWED_EXACT.has(text)) {
      list.push({ line: at(node), text: text.length > 60 ? `${text.slice(0, 57)}…` : text });
    }
  };
  const visit = (node) => {
    if (ts.isJsxText(node)) {
      record(hits, node, node.text.replace(/\s+/g, ' ').trim());
    }
    // A literal value only: `aria-label={t('a.b')}` and any other expression
    // are already going through the catalog (or are dynamic), so only a bare
    // string is debt.
    if (
      ts.isJsxAttribute(node) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer) &&
      LINGUISTIC_ATTRIBUTES.has(node.name.getText())
    ) {
      record(attrHits, node, node.initializer.text.replace(/\s+/g, ' ').trim());
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (hits.length > 0) found.set(rel, hits);
  if (attrHits.length > 0) foundAttrs.set(rel, attrHits);
}

const counts = (map) =>
  Object.fromEntries([...map.entries()].sort().map(([f, h]) => [f, h.length]));
const actual = counts(found);
const actualAttrs = counts(foundAttrs);

if (UPDATE) {
  writeFileSync(
    BASELINE_PATH,
    JSON.stringify(
      {
        $comment:
          'Per-file counts of hardcoded UI English (i18n debt ratchets — see scripts/check-hardcoded-strings.mjs and docs/i18n.md). `files` counts JSX text nodes; `attributes` counts literal values in the attributes a screen reader or placeholder speaks (aria-label, alt, title, placeholder, …). Counts may only decrease; regenerate with `node scripts/check-hardcoded-strings.mjs --update-baseline` ONLY after reducing debt, never to admit new hardcoded strings.',
        files: actual,
        attributes: actualAttrs,
      },
      null,
      2
    ) + '\n'
  );
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  console.log(
    `Baseline updated: ${Object.keys(actual).length} files / ${sum(actual)} JSX strings, ` +
      `${Object.keys(actualAttrs).length} files / ${sum(actualAttrs)} attribute strings.`
  );
  process.exit(0);
}

const stored = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
const baseline = stored.files;
// A baseline written before the attribute ratchet existed has no `attributes`
// key. Treat that as "no debt allowed" rather than "no gate": an absent
// baseline must never read as permission.
const baselineAttrs = stored.attributes ?? {};
const problems = [];
const improvements = [];

/** One ratchet pass. `label` names what is being counted in the failure text. */
function compare(actualCounts, baselineCounts, hitsByFile, label, remedy) {
  for (const [file, count] of Object.entries(actualCounts)) {
    const allowed = baselineCounts[file] ?? 0;
    if (count > allowed) {
      const preview = hitsByFile
        .get(file)
        .slice(0, 5)
        .map((h) => `      L${h.line}: "${h.text}"`)
        .join('\n');
      problems.push(
        `${file}: ${count} ${label} (baseline ${allowed}) — ${remedy} First hits:\n${preview}`
      );
    } else if (count < allowed) {
      improvements.push(`${file}: ${count} ${label} < baseline ${allowed}`);
    }
  }
  for (const file of Object.keys(baselineCounts)) {
    if (!(file in actualCounts))
      improvements.push(`${file}: 0 ${label} < baseline ${baselineCounts[file]} (or file removed)`);
  }
}

compare(
  actual,
  baseline,
  found,
  'hardcoded JSX strings',
  'move new strings into src/i18n/locales/*/translation.json and render via t().'
);
compare(
  actualAttrs,
  baselineAttrs,
  foundAttrs,
  'hardcoded UI attribute strings',
  'an aria-label/alt/title/placeholder literal is what a screen reader says — ' +
    'move it into src/i18n/locales/*/translation.json and pass t(...).'
);

const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const total = sum(actual);
const baselineTotal = sum(baseline);
const totalAttrs = sum(actualAttrs);
const baselineTotalAttrs = sum(baselineAttrs);

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
    `(baseline ${baselineTotal}) and ${totalAttrs} hardcoded UI attribute strings ` +
    `(baseline ${baselineTotalAttrs}), both ratchet-only.`
);
